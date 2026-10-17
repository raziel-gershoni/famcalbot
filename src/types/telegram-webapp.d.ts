// Telegram WebApp TypeScript definitions
// Extends the existing window.Telegram.WebApp types with initDataUnsafe

interface TelegramWebAppUser {
  id: number;
  is_bot?: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

interface TelegramWebAppInitData {
  query_id?: string;
  user?: TelegramWebAppUser;
  receiver?: TelegramWebAppUser;
  chat?: {
    id: number;
    type: string;
    title: string;
    username?: string;
    photo_url?: string;
  };
  chat_type?: string;
  chat_instance?: string;
  start_param?: string;
  can_send_after?: number;
  auth_date: number;
  hash: string;
}

/** Mini App events (activated, deactivated and the two safe-area events need Bot API 8.0). */
type TelegramWebAppEventType =
  | 'themeChanged'
  | 'viewportChanged'
  | 'backButtonClicked'
  | 'mainButtonClicked'
  | 'settingsButtonClicked'
  | 'popupClosed'
  | 'invoiceClosed'
  | 'activated'
  | 'deactivated'
  | 'safeAreaChanged'
  | 'contentSafeAreaChanged';

/** Insets in px (Bot API 8.0); the SDK also sets them as --tg-safe-area-inset-* and --tg-content-safe-area-inset-*. */
interface TelegramWebAppSafeAreaInset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface TelegramWebApp {
  initDataUnsafe: TelegramWebAppInitData;
  initData: string;
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  /** The colours newer clients add (header, accent, section, subtitle, destructive) may be missing on older ones. */
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
    header_bg_color?: string;
    accent_text_color?: string;
    section_bg_color?: string;
    section_header_text_color?: string;
    section_separator_color?: string;
    subtitle_text_color?: string;
    destructive_text_color?: string;
  };
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  safeAreaInset: TelegramWebAppSafeAreaInset;
  contentSafeAreaInset: TelegramWebAppSafeAreaInset;
  headerColor: string;
  backgroundColor: string;
  isClosingConfirmationEnabled: boolean;
  ready: () => void;
  expand: () => void;
  close: () => void;
  setHeaderColor: (color: string) => void;
  setBackgroundColor: (color: string) => void;
  enableClosingConfirmation: () => void;
  disableClosingConfirmation: () => void;
  /** Whether the client supports Bot API `version`. The SDK reports 6.0 in a plain browser. */
  isVersionAtLeast: (version: string) => boolean;
  /** Bot API 7.7+. Never read isVerticalSwipesEnabled: it is wrong after a reload. */
  enableVerticalSwipes: () => void;
  disableVerticalSwipes: () => void;
  onEvent: (eventType: TelegramWebAppEventType, eventHandler: (...args: never[]) => void) => void;
  offEvent: (eventType: TelegramWebAppEventType, eventHandler: (...args: never[]) => void) => void;
  openLink: (url: string, options?: { try_instant_view?: boolean }) => void;
  openTelegramLink: (url: string) => void;
  openInvoice: (url: string, callback?: (status: string) => void) => void;
  showPopup: (params: {
    title?: string;
    message: string;
    buttons?: Array<{ id?: string; type?: string; text?: string }>;
  }, callback?: (buttonId: string) => void) => void;
  showAlert: (message: string, callback?: () => void) => void;
  showConfirm: (message: string, callback?: (confirmed: boolean) => void) => void;
  showScanQrPopup: (params: { text?: string }, callback?: (text: string) => boolean | void) => void;
  closeScanQrPopup: () => void;
  readTextFromClipboard: (callback?: (text: string) => void) => void;
  requestWriteAccess: (callback?: (granted: boolean) => void) => void;
  requestContact: (callback?: (granted: boolean) => void) => void;
  shareToStory: (media_url: string, params?: {
    text?: string;
    widget_link?: { url: string; name?: string };
  }) => void;
  MainButton: {
    text: string;
    color: string;
    textColor: string;
    isVisible: boolean;
    isActive: boolean;
    isProgressVisible: boolean;
    setText: (text: string) => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
    show: () => void;
    hide: () => void;
    enable: () => void;
    disable: () => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
    setParams: (params: {
      text?: string;
      color?: string;
      text_color?: string;
      is_active?: boolean;
      is_visible?: boolean;
    }) => void;
  };
  BackButton: {
    isVisible: boolean;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
    show: () => void;
    hide: () => void;
  };
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp;
  };
}
