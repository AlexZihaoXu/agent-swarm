import { redirect } from 'next/navigation';

// Bare agent URL lands on the desktop view (the primary tab).
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/agents/${id}/desktop`);
}
