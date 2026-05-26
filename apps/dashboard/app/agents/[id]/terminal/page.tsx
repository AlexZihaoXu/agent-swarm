import { MotionPanel } from '../MotionPanel';
import { TerminalPanel } from './TerminalPanel';

export default async function TerminalView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <MotionPanel from="left">
      <TerminalPanel agentId={id} />
    </MotionPanel>
  );
}
