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
// Projects — skeleton only. Repository/deployment fields are
// added in Phase 4/5 once the Developer & Deployment Agents
// define what metadata they actually need.
// ─────────────────────────────────────────────────────────

export const projects = pgTable('projects', {
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
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
  title: text('title').notNull(),
  description: text('description'),
  status: taskStatusEnum('status').notNull().default('queued'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ─────────────────────────────────────────────────────────
// messages — conversation history within a task
// ─────────────────────────────────────────────────────────

export const messages = pgTable('messages', {
  id: uuid('id').defaultRandom().primaryKey(),
  taskId: uuid('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),
  role: text('role').notNull(), // 'system', 'user', 'assistant'
  content: text('content').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

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

export const projectsRelations = relations(projects, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [projects.workspaceId],
    references: [workspaces.id],
  }),
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
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  task: one(tasks, {
    fields: [messages.taskId],
    references: [tasks.id],
  }),
}));
