import { desktopUrl } from '@/lib/gateway';
import { MotionPanel } from '../MotionPanel';

export default async function DesktopView({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <MotionPanel from="right">
      <iframe
        title={`${id} desktop`}
        src={desktopUrl(id)}
        className="h-full w-full border-0 bg-black"
      />
    </MotionPanel>
  );
}
