/**
 * Xirel OS — Database Schema (Phase 1: Foundation)
 *
 * Scope discipline: this file intentionally implements ONLY the tables
 * needed for auth, workspaces, and AI-provider configuration. Tables for
 * agents, tasks, leads, content, social, analytics etc. belong to later
 * phases and are NOT stubbed here — adding empty tables now would create
 * schema debt before the features that need them are designed.
 *
 * `auth.users` is managed by Supabase Auth and is NOT redefined here.
 * We reference it by UUID and mirror the few fields the app needs into
 * `public.profiles`, which is the standard Supabase pattern.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  integer,
  pgEnum,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

// ─────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────

export const workspaceRoleEnum = pgEnum('workspace_role', [
  'owner',
  'admin',
  'member',
  'viewer',
]);

export const aiProviderIdEnum = pgEnum('ai_provider_id', [
  'gemini',
  'groq',
  'qwen',
  'moonshot',
  'openai',
  'anthropic',
  'openrouter',
]);

export const taskStatusEnum = pgEnum('task_status', [
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'completed',
  'failed',
  'cancelled',
]);

export const toolRiskLevelEnum = pgEnum('tool_risk_level', [
  'safe',
  'low',
  'moderate',
  'high',
  'destructive',
]);

// Phase 4: project registry + durable agent runtime state.
export const projectStatusEnum = pgEnum('project_status', [
  'active',
  'paused',
  'archived',
]);

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'queued',
  'planning',
  'running',
  'waiting_for_approval',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'paused',
]);

export const agentStepStatusEnum = pgEnum('agent_step_status', [
  'pending',
  'running',
  'completed',
  'failed',
  'skipped',
  'waiting_approval',
]);

// ─────────────────────────────────────────────────────────
// Profiles — mirrors auth.users, holds app-specific user fields
// ─────────────────────────────────────────────────────────

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey(), // == auth.users.id
  email: text('email').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// Workspaces — isolation boundary for all workspace data
// ─────────────────────────────────────────────────────────

export const workspaces = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'restrict' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  slugIdx: uniqueIndex('workspaces_slug_idx').on(table.slug),
}));

export const workspaceMembers = pgTable('workspace_members', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  role: workspaceRoleEnum('role').notNull().default('member'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  memberUnique: uniqueIndex('workspace_members_unique_idx').on(
    table.workspaceId,
    table.userId
  ),
}));

// ─────────────────────────────────────────────────────────
// Projects — first-class registry object (Phase 4 extension of
// the Phase 1 skeleton). Integration-specific metadata that
// doesn't warrant a column lives in `metadata` jsonb; SECRETS
// never go here (env/secret storage only — see workspace_ai_providers).
// ─────────────────────────────────────────────────────────

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  status: projectStatusEnum('status').notNull().default('active'),
  // Repository metadata (populated when a real GitHub integration exists).
  repoProvider: text('repo_provider'),
  repoUrl: text('repo_url'),
  repoOwner: text('repo_owner'),
  repoName: text('repo_name'),
  // Deployment metadata (populated when a real Vercel/Render integration exists).
  deploymentProvider: text('deployment_provider'),
  deploymentUrl: text('deployment_url'),
  databaseProvider: text('database_provider'),
  /** Non-secret extensible metadata (integration handles, labels, etc.). */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// AI provider configuration — per-workspace enable/priority state.
// The actual capability data (context window, multimodal, etc.)
// lives in code (src/lib/ai/providers/*) since it changes with
// provider releases, not per-workspace. This table only stores
// what a workspace has chosen: which providers, in what order.
// ─────────────────────────────────────────────────────────

export const workspaceAiProviders = pgTable('workspace_ai_providers', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  providerId: aiProviderIdEnum('provider_id').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  priority: text('priority').notNull().default('100'), // lower = tried first
  // Non-secret config only (e.g. base URL for Qwen-compatible endpoints).
  // API keys are NEVER stored in the database — they live in server-side
  // environment variables / secret manager only. See src/lib/ai/config.ts.
  config: jsonb('config').$type<Record<string, unknown>>().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  workspaceProviderUnique: uniqueIndex('workspace_ai_providers_unique_idx').on(
    table.workspaceId,
    table.providerId
  ),
}));

// ─────────────────────────────────────────────────────────
// tasks — individual commands/requests from users
// ─────────────────────────────────────────────────────────

export const tasks = pgTable('tasks', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  /** Nullable: tasks created before Phase 4 (or not project-scoped) have no project. */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  description: text('description'),
  status: taskStatusEnum('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// messages — conversation history within a task
//
// Phase 3 addition: role now includes 'tool' (a tool execution result
// fed back to the model), and assistant messages that requested tool
// calls carry them in toolCalls. See migration 0004 for the matching
// idempotent ALTER TABLE / constraint change.
// ─────────────────────────────────────────────────────────

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'system', 'user', 'assistant', 'tool'
  content: text('content').notNull(),
  /** Present when role = 'assistant' and the model requested tool calls instead of / alongside replying. */
  toolCalls: jsonb('tool_calls').$type<
    { id: string; name: string; arguments: Record<string, unknown> }[]
  >(),
  /** Present when role = 'tool' — must match the id of the AiToolCall this message answers. */
  toolCallId: text('tool_call_id'),
  /** Present when role = 'tool' — the tool's name. */
  toolName: text('tool_name'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// tool_executions — audit log of every tool call an agent makes
// within a task. Phase 3 (Agent Framework). Every tool call is
// logged regardless of success/failure — this is the record that
// lets a human review what an agent actually did, per the project
// spec's requirement that every tool call have error handling and
// (for higher-risk tools, in a later phase) an approval trail.
// ─────────────────────────────────────────────────────────

export const toolExecutions = pgTable('tool_executions', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  /** Nullable: pre-Phase-4 rows have no run; new rows link the audit entry to the agent run. */
  runId: uuid('run_id'),
  toolName: text('tool_name').notNull(),
  riskLevel: toolRiskLevelEnum('risk_level').notNull(),
  input: jsonb('input').$type<Record<string, unknown>>().notNull(),
  output: jsonb('output').$type<Record<string, unknown>>(),
  success: boolean('success').notNull(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// agent_runs — durable agent executions (Phase 4). A run is the
// unit of agent work: it survives the HTTP request that started
// it, records its trajectory in agent_steps/agent_events, and
// can end in waiting_for_approval instead of executing risky
// actions unattended. Status lifecycle mirrors task_status plus
// agent-specific states (verifying, paused).
// ─────────────────────────────────────────────────────────

export const agentRuns = pgTable('agent_runs', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** Nullable: the run survives task deletion. */
  taskId: uuid('task_id').references(() => tasks.id, { onDelete: 'set null' }),
  /** Nullable: set once a project is resolved/created during the run. */
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => profiles.id, { onDelete: 'cascade' }),
  status: agentRunStatusEnum('status').notNull().default('queued'),
  /** Human-readable label of the step the run is currently on. */
  currentStep: text('current_step'),
  error: text('error'),
  /** Non-secret execution metadata (provider used, iteration counts, plan source...). */
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// agent_steps — the per-step trajectory of a run. input/output
// are jsonb: step payloads vary by step type (plan, tool call,
// verification) and a rigid column per field would freeze the
// shape prematurely. sequence gives deterministic ordering.
// ─────────────────────────────────────────────────────────

export const agentSteps = pgTable('agent_steps', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id')
    .notNull()
    .references(() => agentRuns.id, { onDelete: 'cascade' }),
  sequence: integer('sequence').notNull(),
  /** Free-form: 'plan', 'tool', 'verify', 'respond', ... — new step kinds must not require a migration. */
  stepType: text('step_type').notNull(),
  description: text('description').notNull(),
  status: agentStepStatusEnum('status').notNull().default('pending'),
  input: jsonb('input').$type<Record<string, unknown> | null>(),
  output: jsonb('output').$type<Record<string, unknown> | null>(),
  toolName: text('tool_name'),
  error: text('error'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// agent_events — append-only activity feed ("Resolving
// project...", "Executing tool...", "Verifying result...").
// The UI-facing representation of the trajectory; run_id is
// nullable so workspace-level events are also expressible.
// ─────────────────────────────────────────────────────────

export const agentEvents = pgTable('agent_events', {
  id: uuid('id').defaultRandom().primaryKey(),
  runId: uuid('run_id').references(() => agentRuns.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull(),
  message: text('message').notNull(),
  data: jsonb('data').$type<Record<string, unknown> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// project_memory — structured long-lived project knowledge,
// deliberately separate from raw chat history. (project_id,
// kind, key) is unique so "current status"-style entries can be
// updated in place while decision/problem history accumulates.
// ─────────────────────────────────────────────────────────

export const projectMemory = pgTable('project_memory', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  /** 'decision' | 'problem' | 'status' | 'fact' | 'note' — open vocabulary, validated at the API layer. */
  kind: text('kind').notNull(),
  key: text('key').notNull().default(''),
  content: text('content').notNull(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({
  entryUnique: uniqueIndex('project_memory_entry_idx').on(
    table.projectId,
    table.kind,
    table.key
  ),
}));

// ─────────────────────────────────────────────────────────
// Relations (for Drizzle's relational query API)
// ─────────────────────────────────────────────────────────

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  members: many(workspaceMembers),
  projects: many(projects),
  aiProviders: many(workspaceAiProviders),
  owner: one(profiles, {
    fields: [workspaces.ownerId],
    references: [profiles.id],
  }),
}));

export const workspaceMembersRelations = relations(workspaceMembers, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [workspaceMembers.workspaceId],
    references: [workspaces.id],
  }),
  user: one(profiles, {
    fields: [workspaceMembers.userId],
    references: [profiles.id],
  }),
}));

export const projectsRelations = relations(projects, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
  tasks: many(tasks),
  runs: many(agentRuns),
  memory: many(projectMemory),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [tasks.workspaceId],
    references: [workspaces.id],
  }),
  user: one(profiles, {
    fields: [tasks.userId],
    references: [profiles.id],
  }),
  project: one(projects, {
    fields: [tasks.projectId],
    references: [projects.id],
  }),
  messages: many(messages),
  toolExecutions: many(toolExecutions),
  runs: many(agentRuns),
}));

export const toolExecutionsRelations = relations(toolExecutions, ({ one }) => ({
  task: one(tasks, {
    fields: [toolExecutions.taskId],
    references: [tasks.id],
  }),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  task: one(tasks, {
    fields: [messages.taskId],
    references: [tasks.id],
  }),
}));

export const agentRunsRelations = relations(agentRuns, ({ one, many }) => ({
  workspace: one(workspaces, {
    fields: [agentRuns.workspaceId],
    references: [workspaces.id],
  }),
  task: one(tasks, {
    fields: [agentRuns.taskId],
    references: [tasks.id],
  }),
  project: one(projects, {
    fields: [agentRuns.projectId],
    references: [projects.id],
  }),
  user: one(profiles, {
    fields: [agentRuns.userId],
    references: [profiles.id],
  }),
  steps: many(agentSteps),
  events: many(agentEvents),
}));

export const agentStepsRelations = relations(agentSteps, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentSteps.runId],
    references: [agentRuns.id],
  }),
}));

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  run: one(agentRuns, {
    fields: [agentEvents.runId],
    references: [agentRuns.id],
  }),
  workspace: one(workspaces, {
    fields: [agentEvents.workspaceId],
    references: [workspaces.id],
  }),
}));

export const projectMemoryRelations = relations(projectMemory, ({ one }) => ({
  project: one(projects, {
    fields: [projectMemory.projectId],
    references: [projects.id],
  }),
  workspace: one(workspaces, {
    fields: [projectMemory.workspaceId],
    references: [workspaces.id],
  }),
}));
