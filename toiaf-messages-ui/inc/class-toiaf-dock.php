<?php
/**
 * TOIAF Network — Concierge dock backend.
 *
 * Serves one feed for the floating dock: conversations, every notification,
 * and the unread counts behind both.
 *
 * Notifications are stored here rather than only fired as toasts. The existing
 * toiaf-ux-notification-center shows a toast and the toast disappears; a
 * creator who was not looking at the screen never learns a tip arrived. Every
 * event recorded through TOIAF_Dock::notify() gets a durable row AND can still
 * fire its toast.
 *
 * INTEGRATION POINTS:
 *   toiaf_dock_conversations  (filter) recent threads for the current user
 *   toiaf_dock_notifications  (filter) merge in rows from another source
 *   toiaf_dock_enabled        (filter) suppress the dock on given screens
 *
 * @package TOIAF
 */

defined( 'ABSPATH' ) || exit;

class TOIAF_Dock {

	const VERSION   = '1.0.0';
	const NAMESPACE = 'toiaf/v1';
	const TABLE     = 'toiaf_notifications';

	/** Feed size. A dock is a glance surface, not an archive. */
	const LIMIT = 40;

	/** Recognised kinds. Presentation lives in the JS; this is just validation. */
	const KINDS = array(
		'tip', 'unlock', 'subscriber', 'payout', 'booking',
		'custom', 'follower', 'approved', 'message', 'system',
	);

	public static function init() {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
		add_action( 'after_switch_theme', array( __CLASS__, 'install_table' ) );
		add_action( 'wp_enqueue_scripts', array( __CLASS__, 'enqueue' ) );

		// Every paid unlock becomes a notification for the creator.
		add_action( 'toiaf_message_unlocked', array( __CLASS__, 'on_unlock' ), 10, 4 );
	}

	/* ------------------------------------------------------------------ db */

	public static function table() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	public static function install_table() {
		global $wpdb;

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';

		$table = self::table();

		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				user_id BIGINT UNSIGNED NOT NULL,
				kind VARCHAR(32) NOT NULL DEFAULT 'system',
				priority VARCHAR(16) NOT NULL DEFAULT 'normal',
				title VARCHAR(190) NOT NULL DEFAULT '',
				body TEXT NULL,
				amount DECIMAL(16,4) NULL,
				url VARCHAR(255) NOT NULL DEFAULT '',
				actor_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
				is_read TINYINT(1) NOT NULL DEFAULT 0,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY user_unread (user_id, is_read, id),
				KEY user_created (user_id, created_at)
			) " . $wpdb->get_charset_collate() . ';'
		);
	}

	/* ------------------------------------------------------------ recording */

	/**
	 * Record a notification. Safe to call from anywhere.
	 *
	 * @param int    $user_id Recipient.
	 * @param string $kind    One of self::KINDS.
	 * @param array  $args    title, body, amount, url, priority, actor_id.
	 * @return int|false Row id, or false.
	 */
	public static function notify( $user_id, $kind, array $args = array() ) {
		global $wpdb;

		$user_id = absint( $user_id );
		if ( ! $user_id ) {
			return false;
		}

		$kind = in_array( $kind, self::KINDS, true ) ? $kind : 'system';

		$args = wp_parse_args(
			$args,
			array(
				'title'    => '',
				'body'     => '',
				'amount'   => null,
				'url'      => '',
				'priority' => 'normal',
				'actor_id' => 0,
			)
		);

		$ok = $wpdb->insert(
			self::table(),
			array(
				'user_id'    => $user_id,
				'kind'       => $kind,
				'priority'   => in_array( $args['priority'], array( 'normal', 'high', 'critical' ), true )
					? $args['priority'] : 'normal',
				'title'      => sanitize_text_field( (string) $args['title'] ),
				'body'       => wp_kses_post( (string) $args['body'] ),
				'amount'     => is_null( $args['amount'] ) ? null : (float) $args['amount'],
				'url'        => esc_url_raw( (string) $args['url'] ),
				'actor_id'   => absint( $args['actor_id'] ),
				'is_read'    => 0,
				'created_at' => current_time( 'mysql' ),
			)
		);

		return $ok ? (int) $wpdb->insert_id : false;
	}

	/** A paid message unlock is money in — the creator hears about it. */
	public static function on_unlock( $buyer_id, $message_id, $price, $creator_id ) {
		$buyer = get_userdata( $buyer_id );

		self::notify(
			$creator_id,
			'unlock',
			array(
				'title'    => __( 'Paid message unlocked', 'toiaf' ),
				/* translators: %s: buyer display name. */
				'body'     => sprintf( __( '%s unlocked your paid message.', 'toiaf' ), $buyer ? $buyer->display_name : __( 'A member', 'toiaf' ) ),
				'amount'   => $price,
				'priority' => 'high',
				'actor_id' => $buyer_id,
				'url'      => home_url( '/messages/?with=' . absint( $buyer_id ) ),
			)
		);
	}

	/* ---------------------------------------------------------------- rest */

	public static function register_routes() {
		$auth = function () {
			return is_user_logged_in();
		};

		register_rest_route(
			self::NAMESPACE,
			'/dock/feed',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'handle_feed' ),
				'permission_callback' => $auth,
			)
		);

		register_rest_route(
			self::NAMESPACE,
			'/dock/seen',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'handle_seen' ),
				'permission_callback' => $auth,
				'args'                => array(
					'scope' => array(
						'required'          => true,
						'sanitize_callback' => 'sanitize_key',
						'validate_callback' => function ( $v ) {
							return in_array( $v, array( 'messages', 'activity' ), true );
						},
					),
				),
			)
		);
	}

	public static function handle_feed() {
		$user_id = get_current_user_id();

		return new WP_REST_Response(
			array(
				'notifications' => self::notifications( $user_id ),
				'conversations' => self::conversations( $user_id ),
				'unread'        => self::unread( $user_id ),
			),
			200
		);
	}

	public static function handle_seen( WP_REST_Request $request ) {
		global $wpdb;

		$user_id = get_current_user_id();
		$scope   = $request->get_param( 'scope' );

		if ( 'activity' === $scope ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery
			$wpdb->query(
				$wpdb->prepare(
					'UPDATE ' . self::table() . ' SET is_read = 1 WHERE user_id = %d AND is_read = 0',
					$user_id
				)
			);
		} else {
			/**
			 * Mark message threads read. Message storage is theme-owned.
			 *
			 * @param int $user_id
			 */
			do_action( 'toiaf_dock_mark_messages_read', $user_id );
		}

		return new WP_REST_Response(
			array(
				'ok'     => true,
				'unread' => self::unread( $user_id ),
			),
			200
		);
	}

	/* --------------------------------------------------------------- data */

	public static function notifications( $user_id ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$rows = $wpdb->get_results(
			$wpdb->prepare(
				'SELECT kind, priority, title, body, amount, url, is_read, created_at
				 FROM ' . self::table() . '
				 WHERE user_id = %d
				 ORDER BY id DESC
				 LIMIT %d',
				$user_id,
				self::LIMIT
			),
			ARRAY_A
		);

		$out = array();

		foreach ( (array) $rows as $r ) {
			$out[] = array(
				'kind'     => $r['kind'],
				'priority' => $r['priority'],
				'title'    => $r['title'],
				'body'     => $r['body'],
				'amount'   => is_null( $r['amount'] ) ? null : self::trim_amount( $r['amount'] ),
				'url'      => $r['url'],
				'unread'   => ! (int) $r['is_read'],
				'ts'       => (int) mysql2date( 'U', $r['created_at'], false ),
			);
		}

		/**
		 * Merge notifications from another source (a plugin, an external feed).
		 * Rows must match the shape above; the dock sorts by `ts`.
		 *
		 * @param array $out
		 * @param int   $user_id
		 */
		$out = apply_filters( 'toiaf_dock_notifications', $out, $user_id );

		usort(
			$out,
			function ( $a, $b ) {
				return (int) $b['ts'] <=> (int) $a['ts'];
			}
		);

		return array_slice( $out, 0, self::LIMIT );
	}

	/**
	 * Recent conversations. Theme-owned, so this returns nothing until the
	 * filter is wired — an empty list, never a guess.
	 *
	 * Row shape: name, preview, url, avatar, ts, unread (bool), presence.
	 */
	public static function conversations( $user_id ) {
		/**
		 * @param array $conversations
		 * @param int   $user_id
		 */
		$rows = apply_filters( 'toiaf_dock_conversations', array(), $user_id );

		return is_array( $rows ) ? array_slice( $rows, 0, 12 ) : array();
	}

	public static function unread( $user_id ) {
		global $wpdb;

		// phpcs:ignore WordPress.DB.DirectDatabaseQuery
		$activity = (int) $wpdb->get_var(
			$wpdb->prepare(
				'SELECT COUNT(*) FROM ' . self::table() . ' WHERE user_id = %d AND is_read = 0',
				$user_id
			)
		);

		/**
		 * Unread message threads for this user.
		 *
		 * @param int $count
		 * @param int $user_id
		 */
		$messages = (int) apply_filters( 'toiaf_dock_unread_messages', 0, $user_id );

		return array(
			'activity' => $activity,
			'messages' => $messages,
		);
	}

	private static function trim_amount( $n ) {
		$n = (float) $n;
		return ( floor( $n ) === $n ) ? (string) (int) $n : rtrim( rtrim( number_format( $n, 2, '.', '' ), '0' ), '.' );
	}

	/* ------------------------------------------------------------- assets */

	public static function enqueue() {
		if ( ! self::is_enabled() ) {
			return;
		}

		$dir = get_stylesheet_directory_uri();

		wp_enqueue_style( 'toiaf-dock', $dir . '/assets/css/toiaf-dock.css', array(), self::VERSION );
		wp_enqueue_script( 'toiaf-dock', $dir . '/assets/js/toiaf-dock.js', array(), self::VERSION, true );

		wp_localize_script(
			'toiaf-dock',
			'TOIAF_DOCK',
			array(
				'restUrl'     => esc_url_raw( rest_url( self::NAMESPACE . '/dock' ) ),
				'nonce'       => wp_create_nonce( 'wp_rest' ),
				'currency'    => (string) apply_filters( 'toiaf_paywall_currency_label', 'TP' ),
				'messagesUrl' => home_url( '/messages/' ),
				'isCreator'   => self::is_creator(),
				'pollSeconds' => (int) apply_filters( 'toiaf_dock_poll_seconds', 60 ),
				'locale'      => str_replace( '_', '-', get_user_locale() ),
			)
		);
	}

	private static function is_enabled() {
		$enabled = is_user_logged_in();

		/**
		 * Suppress the dock on particular screens (checkout, a live room).
		 *
		 * @param bool $enabled
		 */
		return (bool) apply_filters( 'toiaf_dock_enabled', $enabled );
	}

	private static function is_creator() {
		$user = wp_get_current_user();
		return $user && array_intersect( array( 'toiaf_model', 'toiaf_creator' ), (array) $user->roles ) ? true : false;
	}
}

TOIAF_Dock::init();
