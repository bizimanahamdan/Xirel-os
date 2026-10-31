/**
 * Connector interfaces (Phase 8) — authorized doors to external
 * services. These are INTERFACES ONLY: no client, no credentials, no
 * pretending. Each real connector must:
 *   1. implement its interface,
 *   2. be feature-detected via isConfigured() from env,
 *   3. surface honest errors (no fabricated success),
 *   4. expose only capabilities the credentials actually carry.
 *
 * Everything consequential returns a `consequential: true` result that
 * callers MUST route through the approval checkpoint system — external
 * publishing/deployment never executes unattended.
 */

export interface ConnectorStatus {
  /** e.g. 'github', 'clips_forge', 'object_storage'. */
  kind: string;
  /** True only when the required env/credentials are present AND verified. */
  configured: boolean;
  /** Concrete missing dependency when configured=false. */
  missing?: string[];
}

export interface ExternalActionResult {
  ok: boolean;
  /** Externally visible effect (publish, deploy...) — needs approval flow. */
  consequential: boolean;
  /** Stable external id (workflow run, job id, asset id) when one exists. */
  externalId?: string;
  /** Distinguish claimed vs confirmed outcomes. */
  confirmed: boolean;
  detail?: string;
  error?: string;
}

/** Version control (GitHub et al). */
export interface RepositoryConnector {
  readonly status: ConnectorStatus;
  /** Read-only operations — safe. */
  getRepository(owner: string, name: string): Promise<ExternalActionResult>;
  listRecentCommits(owner: string, name: string, limit: number): Promise<ExternalActionResult>;
  /** Consequential — approval required. */
  createPullRequest(params: {
    owner: string;
    name: string;
    title: string;
    head: string;
    base: string;
    body?: string;
  }): Promise<ExternalActionResult>;
}

/** Deployment (Vercel et al). */
export interface DeploymentConnector {
  readonly status: ConnectorStatus;
  getDeploymentStatus(deploymentId: string): Promise<ExternalActionResult>;
  /** Consequential — approval required. */
  triggerDeployment(params: { projectId: string; ref?: string }): Promise<ExternalActionResult>;
}

/** Managed database (Supabase management API et al) — heavily gated. */
export interface DatabaseConnector {
  readonly status: ConnectorStatus;
  getProjectHealth(projectRef: string): Promise<ExternalActionResult>;
  /** Consequential + destructive-risk — approval required, audited. */
  runMigration?(params: { projectRef: string; sql: string }): Promise<ExternalActionResult>;
}

/**
 * Video generation (Clips Forge). The Phase 9 contract — implemented
 * only against a VERIFIED API (see docs/integrations/clips-forge.md).
 */
export interface VideoGenerationConnector {
  readonly status: ConnectorStatus;
  /** Submit an authenticated generation request. Returns a job id. */
  submitGenerationJob(params: {
    brief: string;
    clipCount: number;
    options?: Record<string, unknown>;
  }): Promise<ExternalActionResult>;
  /** Job status — polling model (webhooks if the API supports them). */
  getJobStatus(jobId: string): Promise<ExternalActionResult & { state?: 'queued' | 'processing' | 'done' | 'failed' }>;
  /** Retrieve the generated asset (URL/reference) for durable storage. */
  retrieveAsset(jobId: string): Promise<ExternalActionResult & { assetUrl?: string }>;
}

/**
 * Object storage for execution artifacts (generated files, images,
 * videos, documents). Render's filesystem is ephemeral — artifacts are
 * ONLY durable here or in Supabase storage.
 */
export interface StorageConnector {
  readonly status: ConnectorStatus;
  put(params: { key: string; body: Buffer; contentType: string }): Promise<ExternalActionResult & { url?: string }>;
  get(params: { key: string }): Promise<ExternalActionResult & { body?: Buffer }>;
  exists(params: { key: string }): Promise<ExternalActionResult & { exists?: boolean }>;
}

/**
 * Authorized browser execution (Phase 10). Interface + security
 * boundary FIRST; a real isolated-browser service is a separate,
 * later deliverable (see docs/integrations/browser-execution.md).
 */
export interface BrowserExecutionConnector {
  readonly status: ConnectorStatus;
  /** All methods operate in an ISOLATED session — never personal cookies. */
  navigate(params: { sessionId: string; url: string }): Promise<ExternalActionResult>;
  inspectPage(params: { sessionId: string }): Promise<ExternalActionResult & { summary?: string }>;
  /** Consequential (clicking/typing/uploading on external sites). */
  act(params: {
    sessionId: string;
    action: 'click' | 'type' | 'upload' | 'download';
    target: string;
    value?: string;
  }): Promise<ExternalActionResult>;
  screenshot(params: { sessionId: string }): Promise<ExternalActionResult & { imageRef?: string }>;
}
