import { redirect } from 'next/navigation';

// Bare agent URL lands on the terminal view.
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/agents/${id}/terminal`);
}
