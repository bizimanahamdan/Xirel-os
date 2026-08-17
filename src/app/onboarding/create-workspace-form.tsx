'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { createWorkspace, type CreateWorkspaceState } from '@/lib/workspaces/create-workspace';

const initialState: CreateWorkspaceState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {pending ? 'Creating…' : 'Create workspace'}
    </button>
  );
}

export default function CreateWorkspaceForm() {
  const [state, formAction] = useActionState(createWorkspace, initialState);

  return (
    <form action={formAction} className="space-y-3">
      <input
        name="name"
        required
        minLength={2}
        maxLength={64}
        placeholder="Acme Inc."
        autoFocus
        className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <SubmitButton />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
