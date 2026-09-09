import { Hono } from 'hono'
import { cors } from 'hono/cors';
import { PinataSDK } from 'pinata'
import { getModelStatus, listLiveModels } from './live/service'
import { StripCashNotConfiguredError } from './live/stripcash'
import type { LiveStreamsEnv } from './live/types'

interface Bindings extends LiveStreamsEnv {
  PINATA_JWT: string;
  GATEWAY_URL: string;
}

const app = new Hono<{ Bindings: Bindings }>()

app.use(cors())

function viewerCountry(request: Request): string | undefined {
  return (request as { cf?: { country?: string } }).cf?.country;
}

app.get('/', (c) => {
  return c.text('Hello Hono!')
})

app.get('/presigned_url', async (c) => {

	// Handle Auth

  const pinata = new PinataSDK({
    pinataJwt: c.env.PINATA_JWT,
    pinataGateway: c.env.GATEWAY_URL
  })

  const url = await pinata.upload.public.createSignedURL({
    expires: 60 // Last for 60 seconds
  })

  return c.json({ url }, { status: 200 })
})

// Live model feed for topnotch.toiaf.com/live/, sourced from the StripCash
// Models API for aggregators. Never exposes provider stream/HLS URLs or
// images — only username, live status, and the on-site profile link.
app.get('/topnotch/live', async (c) => {
  try {
    const feed = await listLiveModels(c.env, viewerCountry(c.req.raw))
    return c.json(feed, { status: 200 })
  } catch (error) {
    if (error instanceof StripCashNotConfiguredError) {
      return c.json({ error: error.message }, { status: 503 })
    }
    console.error(error)
    return c.json({ error: 'Failed to load live streams' }, { status: 502 })
  }
})

app.get('/topnotch/live/model/:username', async (c) => {
  const username = c.req.param('username')
  try {
    const model = await getModelStatus(c.env, username, viewerCountry(c.req.raw))
    return c.json(model ?? { username, live: false }, { status: 200 })
  } catch (error) {
    if (error instanceof StripCashNotConfiguredError) {
      return c.json({ error: error.message }, { status: 503 })
    }
    console.error(error)
    return c.json({ error: 'Failed to load model status' }, { status: 502 })
  }
})

export default app
