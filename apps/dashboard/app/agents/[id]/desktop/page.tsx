import { desktopUrl } from '@/lib/gateway';
import { MotionPanel } from '../MotionPanel';
import { DesktopPanel } from './DesktopPanel';

export default async function DesktopView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <MotionPanel from="left">
      <DesktopPanel src={desktopUrl(id)} title={`${id} desktop`} />
    </MotionPanel>
  );
}
