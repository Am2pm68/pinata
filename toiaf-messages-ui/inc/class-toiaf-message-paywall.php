<?php
/**
 * TOIAF Network — myCred message paywall.
 *
 * One purchase, one debit, one unlock. Charges the buyer in myCred (TP),
 * credits the creator, and records the grant in a table with a UNIQUE key so
 * a double-click or a retried request can never charge twice.
 *
 * INTEGRATION POINTS — the three things this file cannot know about your
 * schema. Wire these in the theme and everything else works as-is:
 *
 *   toiaf_paywall_message      (filter) return the message row for an ID
 *   toiaf_paywall_media        (filter) return the signed media payload
 *   toiaf_paywall_point_type   (filter) the myCred point type slug
 *
 * @package TOIAF
 */

defined( 'ABSPATH' ) || exit;

class TOIAF_Message_Paywall {

	const VERSION   = '1.0.0';
	const NAMESPACE = 'toiaf/v1';
	const TABLE     = 'toiaf_message_unlocks';

	/** Default myCred point type. TOIAF calls its points "TP". */
	const POINT_TYPE = 'mycred_default';

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'after_switch_theme', array( __CLASS__, 'install_table' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );
	}

	/* ------------------------------------------------------------------ db */

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	/**
	 * The UNIQUE KEY on (user_id, message_id) is what makes the charge
	 * idempotent — see charge() for how that is used.
	 */
	public static function install_table() {
		global $wpdb;

		$table   = self::table();
		$collate = $wpdb->get_charset_collate();

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				message_id BIGINT UNSIGNED NOT NULL,
				creator_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				price DECIMAL(16,4) NOT NULL DEFAULT 0,
				point_type VARCHAR(64) NOT NULL DEFAULT '',
				unlocked_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY user_message (user_id, message_id),
				KEY creator_id (creator_id)
			) {$collate};"
		);
	}

	/* --------------------------------------------------------------- rest */

	public static function register_routes() {
		register_rest_route(
			self::NAMESPACE,
			'/messages/unlock',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'handle_unlock' ),
				'permission_callback' => function () {
					return is_user_logged_in();
				},
				'args'                => array(
					'message_id' => array(
						'required'          => true,
						'sanitize_callback' => 'absint',
						'validate_callback' => function ( $v ) {
							return absint( $v ) > 0;
						},
					),
				),
			)
		);
	}

	public static function handle_unlock( WP_REST_Request $request ) {
		$user_id    = get_current_user_id();
		$message_id = absint( $request->get_param( 'message_id' ) );

		$message = self::get_message( $message_id );
		if ( ! $message ) {
			return self::error( 'not_found', __( 'That message no longer exists.', 'toiaf' ), 404 );
		}

		if ( ! self::can_view_thread( $user_id, $message ) ) {
			return self::error( 'forbidden', __( 'This conversation is not yours.', 'toiaf' ), 403 );
		}

		$price = (float) $message['price'];
		$type  = self::point_type();

		// The creator's own message is already theirs.
		if ( (int) $message['creator_id'] === $user_id ) {
			return self::success( $message_id, $message, self::balance( $user_id, $type ), $price );
		}

		// Free, or already paid for: hand over the media without touching points.
		if ( $price <= 0 || self::has_unlocked( $user_id, $message_id ) ) {
			return self::success( $message_id, $message, self::balance( $user_id, $type ), $price );
		}

		$balance = self::balance( $user_id, $type );
		if ( $balance < $price ) {
			return new WP_REST_Response(
				array(
					'ok'        => false,
					'code'      => 'insufficient_funds',
					'message'   => __( 'Not enough TP to unlock this.', 'toiaf' ),
					'balance'   => $balance,
					'price'     => $price,
					'topup_url' => self::topup_url(),
				),
				402
			);
		}

		$charged = self::charge( $user_id, $message, $price, $type );

		if ( is_wp_error( $charged ) ) {
			return self::error(
				$charged->get_error_code(),
				$charged->get_error_message(),
				'insufficient_funds' === $charged->get_error_code() ? 402 : 500
			);
		}

		return self::success( $message_id, $message, self::balance( $user_id, $type ), $price );
	}

	/* ------------------------------------------------------------ charging */

	/**
	 * Claim the unlock first, then move the points.
	 *
	 * The INSERT is the lock: the UNIQUE KEY means a concurrent second
	 * request loses the race and gets 0 affected rows, so only one caller
	 * ever reaches the debit. If the debit then fails we delete the claim,
	 * leaving the buyer exactly where they started.
	 */
	private static function charge( $user_id, array $message, $price, $type ) {
		global $wpdb;

		if ( ! function_exists( 'mycred_subtract' ) ) {
			return new WP_Error( 'mycred_missing', __( 'Payments are unavailable right now.', 'toiaf' ) );
		}

		$message_id = (int) $message['id'];
		$creator_id = (int) $message['creator_id'];

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery -- intentional: the
		// UNIQUE constraint is the concurrency guard.
		$claimed = $wpdb->query(
			$wpdb->prepare(
				'INSERT IGNORE INTO ' . self::table() .
				' (user_id, message_id, creator_id, price, point_type, unlocked_at)
				 VALUES (%d, %d, %d, %f, %s, %s)',
				$user_id,
				$message_id,
				$creator_id,
				$price,
				$type,
				current_time( 'mysql' )
			)
		);

		if ( ! $claimed ) {
			// Someone else already claimed it — that is a success, not an error.
			return true;
		}

		$debited = mycred_subtract(
			'toiaf_message_unlock',
			$user_id,
			$price,
			/* translators: %s: creator display name. */
			sprintf( __( 'Unlocked paid message from %s', 'toiaf' ), self::display_name( $creator_id ) ),
			$message_id,
			array( 'creator_id' => $creator_id ),
			$type
		);

		if ( ! $debited ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->delete(
				self::table(),
				array(
					'user_id'    => $user_id,
					'message_id' => $message_id,
				),
				array( '%d', '%d' )
			);

			return new WP_Error( 'insufficient_funds', __( 'Not enough TP to unlock this.', 'toiaf' ) );
		}

		self::pay_creator( $creator_id, $user_id, $message_id, $price, $type );

		/**
		 * Fires once, after a message has been paid for and unlocked.
		 *
		 * @param int   $user_id    Buyer.
		 * @param int   $message_id Message unlocked.
		 * @param float $price      Amount charged.
		 * @param int   $creator_id Seller.
		 */
		do_action( 'toiaf_message_unlocked', $user_id, $message_id, $price, $creator_id );

		return true;
	}

	private static function pay_creator( $creator_id, $buyer_id, $message_id, $price, $type ) {
		if ( ! $creator_id || ! function_exists( 'mycred_add' ) ) {
			return;
		}

		/**
		 * Network cut, 0.0–1.0. Default 0 — the creator keeps the full price.
		 *
		 * @param float $rate
		 */
		$rate  = (float) apply_filters( 'toiaf_paywall_network_fee', 0.0, $creator_id, $price );
		$rate  = max( 0.0, min( 1.0, $rate ) );
		$share = round( $price * ( 1 - $rate ), 4 );

		if ( $share <= 0 ) {
			return;
		}

		mycred_add(
			'toiaf_message_sale',
			$creator_id,
			$share,
			/* translators: %s: buyer display name. */
			sprintf( __( 'Paid message unlocked by %s', 'toiaf' ), self::display_name( $buyer_id ) ),
			$message_id,
			array( 'buyer_id' => $buyer_id ),
			$type
		);
	}

	/* ------------------------------------------------------------ queries */

	public static function has_unlocked( $user_id, $message_id ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		return (bool) $wpdb->get_var(
			$wpdb->prepare(
				'SELECT id FROM ' . self::table() . ' WHERE user_id = %d AND message_id = %d LIMIT 1',
				$user_id,
				$message_id
			)
		);
	}

	public static function balance( $user_id, $type = null ) {
		$type = $type ? $type : self::point_type();

		if ( ! function_exists( 'mycred_get_users_balance' ) ) {
			return 0.0;
		}

		return (float) mycred_get_users_balance( $user_id, $type );
	}

	public static function point_type() {
		/**
		 * The myCred point type TP is stored under.
		 *
		 * @param string $type
		 */
		return (string) apply_filters( 'toiaf_paywall_point_type', self::POINT_TYPE );
	}

	public static function topup_url() {
		/**
		 * Where "GET TP" sends a buyer who cannot afford the unlock.
		 *
		 * @param string $url
		 */
		return (string) apply_filters(
			'toiaf_paywall_topup_url',
			home_url( '/toiaf-sso-start/?aud=npntoi&redirect_to=' . rawurlencode( 'https://npntoi.com/buy-toiletpapers/?toiaf_checkout=1' ) )
		);
	}

	/**
	 * Load a message.
	 *
	 * Return shape:
	 *   id, creator_id, recipient_id, price (float), kind ('image'|'video'|'file'),
	 *   caption, preview_url (blurred teaser, safe to show unpaid)
	 *
	 * The theme owns message storage, so this MUST be filtered. Returning
	 * null (the default) makes every unlock request 404 rather than guess.
	 */
	public static function get_message( $message_id ) {
		/**
		 * @param array|null $message
		 * @param int        $message_id
		 */
		$message = apply_filters( 'toiaf_paywall_message', null, $message_id );

		if ( ! is_array( $message ) || empty( $message['id'] ) ) {
			return null;
		}

		return wp_parse_args(
			$message,
			array(
				'id'           => 0,
				'creator_id'   => 0,
				'recipient_id' => 0,
				'price'        => 0.0,
				'kind'         => 'image',
				'caption'      => '',
				'preview_url'  => '',
			)
		);
	}

	/**
	 * The signed, watermarked asset. Only ever called after payment clears,
	 * so the URL never has to be guessable from the locked card.
	 */
	public static function get_media( array $message ) {
		/**
		 * @param array $media   { type, url, poster, caption, alt }
		 * @param array $message
		 */
		return apply_filters(
			'toiaf_paywall_media',
			array(
				'type'    => $message['kind'],
				'url'     => '',
				'poster'  => '',
				'caption' => $message['caption'],
				'alt'     => __( 'Unlocked content', 'toiaf' ),
			),
			$message
		);
	}

	private static function can_view_thread( $user_id, array $message ) {
		$allowed = in_array(
			(int) $user_id,
			array( (int) $message['creator_id'], (int) $message['recipient_id'] ),
			true
		);

		/**
		 * @param bool  $allowed
		 * @param int   $user_id
		 * @param array $message
		 */
		return (bool) apply_filters( 'toiaf_paywall_can_view', $allowed, $user_id, $message );
	}

	private static function display_name( $user_id ) {
		$user = get_userdata( $user_id );
		return $user ? $user->display_name : __( 'a TOIAF member', 'toiaf' );
	}

	/* ------------------------------------------------------------ replies */

	private static function success( $message_id, array $message, $balance, $price ) {
		return new WP_REST_Response(
			array(
				'ok'      => true,
				'balance' => (float) $balance,
				'price'   => (float) $price,
				'media'   => self::get_media( $message ),
			),
			200
		);
	}

	private static function error( $code, $message, $status ) {
		return new WP_REST_Response(
			array(
				'ok'      => false,
				'code'    => $code,
				'message' => $message,
			),
			$status
		);
	}

	/* ------------------------------------------------------------- assets */

	public static function enqueue() {
		if ( ! self::is_messages_page() ) {
			return;
		}

		$dir = get_stylesheet_directory_uri();

		wp_enqueue_style(
			'topnotch-toiaf-messages',
			$dir . '/assets/css/toiaf-messages.css',
			array(),
			self::VERSION
		);

		wp_enqueue_script(
			'topnotch-toiaf-messages',
			$dir . '/assets/js/toiaf-messages.js',
			array(),
			self::VERSION,
			true
		);

		wp_localize_script(
			'topnotch-toiaf-messages',
			'TOIAF_MESSAGES',
			array(
				'restUrl'  => esc_url_raw( rest_url( self::NAMESPACE . '/messages' ) ),
				'nonce'    => wp_create_nonce( 'wp_rest' ),
				'currency' => (string) apply_filters( 'toiaf_paywall_currency_label', 'TP' ),
				'topupUrl' => self::topup_url(),
				'balance'  => self::balance( get_current_user_id() ),
				'locale'   => str_replace( '_', '-', get_user_locale() ),
			)
		);
	}

	private static function is_messages_page() {
		return is_user_logged_in() && ( is_page( 'messages' ) || get_query_var( 'toiaf_messages' ) );
	}
}

TOIAF_Message_Paywall::init();
