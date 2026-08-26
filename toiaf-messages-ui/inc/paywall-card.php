<?php
/**
 * TOIAF Network — paywall card renderer.
 *
 * Emits the markup that assets/css/toiaf-messages.css and
 * assets/js/toiaf-messages.js expect. Call it from the message loop in the
 * messages template, in place of the current .tnm-paid-preview block.
 *
 *   toiaf_paywall_card( array(
 *       'message_id'  => 1858,
 *       'price'       => 45,
 *       'balance'     => 4,
 *       'kind'        => 'video',
 *       'meta'        => '2:14',
 *       'preview_url' => $blurred_teaser_url,
 *       'is_own'      => false,
 *       'unlocked'    => false,
 *       'media'       => array( 'type' => 'video', 'url' => $signed_url ),
 *   ) );
 *
 * Without JS the button posts the enclosing form to the same page, so the
 * server-side handler still runs. With JS it is intercepted and unlocks
 * inline via the REST route.
 *
 * @package TOIAF
 */

defined( 'ABSPATH' ) || exit;

if ( ! function_exists( 'toiaf_paywall_card' ) ) :

	function toiaf_paywall_card( array $args = array() ) {
		$a = wp_parse_args(
			$args,
			array(
				'message_id'  => 0,
				'price'       => 0,
				'balance'     => 0,
				'kind'        => 'image',
				'meta'        => '',
				'preview_url' => '',
				'currency'    => apply_filters( 'toiaf_paywall_currency_label', 'TP' ),
				'is_own'      => false,
				'unlocked'    => false,
				'media'       => array(),
				'topup_url'   => '',
			)
		);

		$price   = (float) $a['price'];
		$balance = (float) $a['balance'];

		// One attribute drives CSS and JS alike, so they can never disagree.
		if ( $a['unlocked'] ) {
			$state = 'unlocked';
		} elseif ( $a['is_own'] ) {
			$state = 'own';
		} elseif ( $balance < $price ) {
			$state = 'insufficient';
		} else {
			$state = 'locked';
		}

		$topup = $a['topup_url'];
		if ( ! $topup && class_exists( 'TOIAF_Message_Paywall' ) ) {
			$topup = TOIAF_Message_Paywall::topup_url();
		}

		$labels = array(
			'image' => __( 'Photo', 'toiaf' ),
			'video' => __( 'Video', 'toiaf' ),
			'file'  => __( 'File', 'toiaf' ),
			'audio' => __( 'Audio', 'toiaf' ),
		);
		$kind_label = isset( $labels[ $a['kind'] ] ) ? $labels[ $a['kind'] ] : $labels['image'];
		if ( $a['meta'] ) {
			$kind_label .= ' · ' . $a['meta'];
		}

		$fmt = static function ( $n ) {
			return ( (float) $n === floor( (float) $n ) )
				? number_format_i18n( (float) $n )
				: number_format_i18n( (float) $n, 2 );
		};
		?>
		<div class="tnm-paywall"
			data-tnm-paywall
			data-state="<?php echo esc_attr( $state ); ?>"
			data-message-id="<?php echo esc_attr( (string) $a['message_id'] ); ?>"
			data-price="<?php echo esc_attr( (string) $price ); ?>"
			data-balance="<?php echo esc_attr( (string) $balance ); ?>">

			<div class="tnm-paywall__media">
				<?php if ( 'unlocked' === $state && ! empty( $a['media']['url'] ) ) : ?>
					<?php if ( 'video' === ( $a['media']['type'] ?? '' ) ) : ?>
						<video class="tnm-paywall__blur" controls playsinline preload="metadata"
							<?php if ( ! empty( $a['media']['poster'] ) ) : ?>
								poster="<?php echo esc_url( $a['media']['poster'] ); ?>"
							<?php endif; ?>
							src="<?php echo esc_url( $a['media']['url'] ); ?>"></video>
					<?php else : ?>
						<img class="tnm-paywall__blur"
							src="<?php echo esc_url( $a['media']['url'] ); ?>"
							alt="<?php esc_attr_e( 'Unlocked content', 'toiaf' ); ?>"
							decoding="async">
					<?php endif; ?>
					<?php if ( ! empty( $a['media']['caption'] ) ) : ?>
						<figcaption><?php echo esc_html( $a['media']['caption'] ); ?></figcaption>
					<?php endif; ?>
				<?php elseif ( $a['preview_url'] ) : ?>
					<?php /* The teaser is blurred in CSS. Ship a small, already-degraded
					         thumbnail here too — CSS blur is not access control. */ ?>
					<img class="tnm-paywall__blur"
						src="<?php echo esc_url( $a['preview_url'] ); ?>"
						alt="" aria-hidden="true" decoding="async" loading="lazy">
				<?php endif; ?>
			</div>

			<div class="tnm-paywall__panel">
				<span class="tnm-paywall__badge">
					<?php echo $a['is_own'] ? esc_html__( 'PAID', 'toiaf' ) : esc_html__( 'LOCKED', 'toiaf' ); ?>
				</span>

				<span class="tnm-paywall__kind"><?php echo esc_html( $kind_label ); ?></span>

				<div class="tnm-paywall__price">
					<b><?php echo esc_html( $fmt( $price ) ); ?></b>
					<em><?php echo esc_html( $a['currency'] ); ?></em>
				</div>

				<?php if ( ! $a['is_own'] && ! $a['unlocked'] ) : ?>

					<?php if ( 'insufficient' === $state ) : ?>
						<a class="tnm-paywall__cta" data-action="topup" href="<?php echo esc_url( $topup ); ?>">
							<?php
							/* translators: %s: currency label, e.g. TP. */
							printf( esc_html__( 'GET %s', 'toiaf' ), esc_html( $a['currency'] ) );
							?>
						</a>
					<?php else : ?>
						<form class="tnm-unlock-form" method="post">
							<?php wp_nonce_field( 'toiaf_unlock_' . $a['message_id'], 'toiaf_unlock_nonce' ); ?>
							<input type="hidden" name="toiaf_unlock_message" value="<?php echo esc_attr( (string) $a['message_id'] ); ?>">
							<button class="tnm-paywall__cta" data-action="unlock" type="submit">
								<?php
								printf(
									/* translators: 1: price, 2: currency label. */
									esc_html__( 'UNLOCK FOR %1$s %2$s', 'toiaf' ),
									esc_html( $fmt( $price ) ),
									esc_html( $a['currency'] )
								);
								?>
							</button>
						</form>
					<?php endif; ?>

					<p class="tnm-paywall__balance">
						<?php esc_html_e( 'Balance', 'toiaf' ); ?>
						<b><?php echo esc_html( $fmt( $balance ) . ' ' . $a['currency'] ); ?></b>
					</p>

				<?php endif; ?>

				<p class="tnm-paywall__status" role="status" aria-live="polite"></p>
			</div>
		</div>
		<?php
	}

endif;
