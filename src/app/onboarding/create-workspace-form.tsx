'use client';

import { useState, useTransition } from 'react';
import { createWorkspace, type CreateWorkspaceState } from '@/lib/workspaces/create-workspace';

function SubmitButton({ isPending }: { isPending: boolean }) {
  return (
    <button
      type="submit"
      disabled={isPending}
      className="w-full rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
    >
      {isPending ? 'Creating…' : 'Create workspace'}
    </button>
  );
}

export default function CreateWorkspaceForm() {
  const [isPending, startTransition] = useTransition();
  const [state, setState] = useState<CreateWorkspaceState>({});

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const result = await createWorkspace({}, formData);
      if (result.error) {
        setState(result);
      }
    });
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const formData = new FormData(e.currentTarget);
        handleSubmit(formData);
      }}
      className="space-y-3"
    >
      <input
        name="name"
        required
        minLength={2}
        maxLength={64}
        placeholder="Acme Inc."
        autoFocus
        className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
      />
      <SubmitButton isPending={isPending} />
      {state.error && <p className="text-sm text-red-400">{state.error}</p>}
    </form>
  );
}
