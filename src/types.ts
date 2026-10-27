export type Severity = "error" | "warning" | "info";

export interface Issue {
  severity: Severity;
  category: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
  autoFixed?: boolean;
  /** The runtime shim emulates this call, so it won't throw. */
  shimmed?: boolean;
}

export interface Manifest {
  manifest_version?: number;
  name?: string;
  version?: string;
  version_name?: string;
  description?: string;
  background?: {
    service_worker?: string;
    scripts?: string[];
    page?: string;
    persistent?: boolean;
    type?: string;
    preferred_environment?: string[];
  };
  action?: Record<string, unknown> & { default_popup?: string };
  browser_action?: Record<string, unknown> & { default_popup?: string };
  page_action?: Record<string, unknown> & { default_popup?: string };
  side_panel?: Record<string, unknown> & { default_path?: string };
  sidebar_action?: Record<string, unknown> & {
    default_panel?: string;
    default_title?: string;
    default_icon?: unknown;
    open_at_install?: boolean;
  };
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: Array<{
    js?: string[];
    css?: string[];
    matches?: string[];
    run_at?: string;
    all_frames?: boolean;
    match_about_blank?: boolean;
    world?: "MAIN" | "ISOLATED";
  }>;
  web_accessible_resources?: unknown;
  commands?: Record<string, unknown>;
  externally_connectable?: { ids?: string[]; matches?: string[] };
  content_security_policy?: Record<string, string> | string;
  declarative_net_request?: {
    rule_resources?: Array<{ id: string; enabled: boolean; path: string }>;
  };
  update_url?: string;
  key?: string;
  minimum_chrome_version?: string;
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      strict_max_version?: string;
      data_collection_permissions?: { required?: string[]; optional?: string[] };
      [key: string]: unknown;
    };
    gecko_android?: { strict_min_version?: string; strict_max_version?: string };
    [key: string]: unknown;
  };
  default_locale?: string;
  icons?: Record<string, string>;
  incognito?: string;
  chrome_url_overrides?: Record<string, string>;
  devtools_page?: string;
  options_page?: string;
  options_ui?: { page?: string; open_in_tab?: boolean };
  sandbox?: { pages?: string[] };
  [key: string]: unknown;
}

/** Which Firefox builds the add-on targets: desktop only, Android only, or both. */
export type Platforms = "all" | "desktop" | "android";

/** How the packed add-on gets signed (or not) before it is installed. */
export type SignRoute = "amo" | "unsigned" | "temporary";

export interface AmoCredentials {
  key: string;
  secret: string;
}

export interface ConvertOptions {
  input: string;
  output?: string;
  /** Explicit gecko ID; when absent the ID is derived (see sign/addon-id.ts). */
  addonId?: string;
  platforms: Platforms;
  /** strict_min_version for browser_specific_settings.gecko (default DEFAULT_MIN_FIREFOX). */
  minFirefoxVersion?: string;
  generateShim: boolean;
  force: boolean;
  /** Treat warnings as blocking; --force still overrides. */
  strict?: boolean;
  /** Wipe the output dir before staging. */
  clean?: boolean;
  /** Also write the unsigned staged extension as a .zip. */
  zip?: boolean;
  /** Wire the externally_connectable page bridge and identity polyfill (default on). */
  oauthBridge?: boolean;
  /** Build the shim with debug tracing and the persistent ring-buffer logger. */
  debug?: boolean;
  /** Query string written into the sidebar page URL; undefined = derive from the bundle. */
  panelQuery?: string;
  /** Values for gecko.data_collection_permissions.required; undefined = don't write the key. */
  dataCollection?: string[];
  /** Signing route; "auto" picks amo > unsigned > temporary. */
  sign: SignRoute | "auto";
  amo?: AmoCredentials;
  /** Overrides the version written to the manifest (four-part versions included). */
  addonVersion?: string;
  /** Install into a Firefox profile after packing/signing. */
  install: boolean;
  /** Profile name or path; undefined = the selected install's default profile. */
  profile?: string;
  /** Firefox install path or channel name; undefined = release channel if present. */
  firefox?: string;
  /** After installing, poll extensions.json until the add-on is active. */
  verify?: boolean;
  /** Allow quitting and relaunching Firefox when a pref or remote agent needs a restart. */
  firefoxRestart: boolean;
  /** Launch Firefox to install; false stops once the .xpi is written. */
  launch: boolean;
}

export interface ConvertResult {
  success: boolean;
  extensionName: string;
  manifestVersion: number;
  issues: Issue[];
  /** Web Store ID when known (from the store URL or the manifest key). */
  chromeId?: string;
  addonId?: string;
  /** Version written into the packed manifest. */
  version?: string;
  stagedPath?: string;
  /** Unsigned packed add-on. */
  xpiPath?: string;
  zipPath?: string;
  /** Route actually used, after "auto" was resolved. */
  route?: SignRoute;
  /** AMO-signed .xpi, when the amo route ran. */
  signedXpiPath?: string;
  /** Profile directory the add-on was installed into. */
  profilePath?: string;
  /** Install was requested but did not happen; the caller must exit non-zero. */
  installFailed?: boolean;
}
