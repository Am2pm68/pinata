import { Repo } from './db/repo';
import { config, type Env } from './env';
import type { OutboundMessage } from './types';
import { buildApp } from './api/routes';
import { consumeIntent } from './intents/consumer';
import { log } from './lib/log';
import { runCron } from './schedule/cron';

const app = buildApp();

export default {
  fetch: app.fetch,

  /**
   * Cron trigger: the control plane's heartbeat. Reads live truth, opens and
   * closes sessions, plans due posts. Runs every minute by default.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      runCron(env).catch((err: unknown) => {
        log('error', 'scheduled.failed', { error: String(err) });
      }),
    );
  },

  /**
   * Delivery. Each message is one intent; the conditional claim inside
   * `consumeIntent` is what makes at-least-once delivery safe to run against
   * real social APIs.
   */
  async queue(batch: MessageBatch<OutboundMessage>, env: Env) {
    const repo = new Repo(env.DB);
    const cfg = config(env);

    for (const message of batch.messages) {
      try {
        const outcome = await consumeIntent(repo, env, cfg, message.body);
        if (outcome.action === 'retry') {
          message.retry({ delaySeconds: Math.min(300, 15 * 2 ** batch.messages.length) });
        } else {
          message.ack();
        }
      } catch (err) {
        // An unexpected throw must not silently drop an announcement: retry and
        // let the queue's own max_retries decide when to give up to the DLQ.
        log('error', 'queue.unhandled', {
          intent_id: message.body?.intent_id,
          error: String(err),
        });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, OutboundMessage>;
