import { useEffect } from 'react';
import { Download, ExternalLink, X } from 'lucide-react';
import { useMediaViewerStore } from '../../stores/mediaViewerStore';

export default function MediaViewerHost() {
  const item = useMediaViewerStore(state => state.item);
  const closeMedia = useMediaViewerStore(state => state.closeMedia);

  useEffect(() => {
    if (!item) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMedia();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [item, closeMedia]);

  if (!item) return null;

  return (
    <div className="media-viewer-host" role="dialog" aria-modal="true" aria-label={`${item.kind === 'image' ? 'Image' : 'Video'} viewer: ${item.title}`}>
      <header>
        <div>
          <strong>{item.title}</strong>
          <span>{item.kind === 'image' ? 'Image viewer' : 'Video viewer'}</span>
        </div>
        <div className="media-viewer-host__actions">
          {item.downloadUrl && (
            <a href={item.downloadUrl} download={item.title} title="Download media">
              <Download aria-hidden="true" />
              <span>Download</span>
            </a>
          )}
          {/^https?:/i.test(item.src) && (
            <a href={item.src} target="_blank" rel="noopener noreferrer" title="Open media externally">
              <ExternalLink aria-hidden="true" />
              <span>Open externally</span>
            </a>
          )}
          <button type="button" onClick={closeMedia} aria-label="Close media viewer" title="Close (Esc)">
            <X aria-hidden="true" />
          </button>
        </div>
      </header>
      <main>
        {item.kind === 'image' ? (
          <img src={item.src} alt={item.title} />
        ) : (
          <video controls autoPlay playsInline aria-label={item.title}>
            <source src={item.src} type={item.mimeType} />
            Your browser does not support this video.
          </video>
        )}
      </main>
    </div>
  );
}
