import { useEffect, useRef } from 'react';

interface Props {
  text: string;
  isLive?: boolean;
}

export default function StreamOutput({ text, isLive }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isLive) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [text, isLive]);

  return (
    <div className="relative bg-surface-200 rounded max-h-72 overflow-auto font-mono text-xs">
      {isLive && (
        <div className="sticky top-0 right-0 flex justify-end p-1">
          <span className="flex items-center gap-1 text-[10px] text-green-400 bg-surface-300 px-2 py-0.5 rounded-full">
            <span className="w-1.5 h-1.5 bg-green-400 rounded-full animate-pulse" />
            streaming
          </span>
        </div>
      )}
      <pre className="p-3 whitespace-pre-wrap text-gray-300 leading-relaxed">
        {text || <span className="text-gray-500 italic">No output yet...</span>}
      </pre>
      <div ref={endRef} />
    </div>
  );
}
