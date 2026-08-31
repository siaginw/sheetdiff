import Link from 'next/link';
import { GitCompareArrows } from 'lucide-react';

export default function NotFound() {
  return (
    <div className='flex min-h-dvh flex-col items-center justify-center gap-4 px-4 text-center'>
      <span className='flex size-10 items-center justify-center rounded-lg bg-muted'>
        <GitCompareArrows className='size-5 text-muted-foreground' />
      </span>
      <h1 className='text-xl font-semibold'>That page doesn&rsquo;t exist</h1>
      <p className='max-w-sm text-sm text-muted-foreground'>
        The sheet may have been removed, or the link is from an old session.
      </p>
      <Link
        href='/'
        className='rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/80'
      >
        Back to your sheets
      </Link>
    </div>
  );
}
