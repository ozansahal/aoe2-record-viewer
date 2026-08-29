import { useState, type DragEvent } from "react";
import styles from "./DropZone.module.css";

interface Props {
  busy: boolean;
  status: string;
  error: boolean;
  onFiles: (files: File[]) => void;
}

export function DropZone({ busy, status, error, onFiles }: Props) {
  const [over, setOver] = useState(false);

  const swallow = (event: DragEvent<HTMLDivElement>) => event.preventDefault();

  return (
    <div
      className={[styles.empty, over && styles.over, busy && styles.busy].filter(Boolean).join(" ")}
      onDragEnter={(e) => { swallow(e); setOver(true); }}
      onDragOver={(e) => { swallow(e); setOver(true); }}
      onDragLeave={(e) => { swallow(e); setOver(false); }}
      onDrop={(e) => {
        swallow(e);
        /* The window has a handler of its own, for files dropped anywhere
           else. Without this the same drop would be opened by both. */
        e.stopPropagation();
        setOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) onFiles(files);
      }}
    >
      <div><strong>Drop .aoe2record files here</strong>, or use the button above.</div>
      <div className={styles.hint}>
        Recordings are read on this device and never uploaded. Drop as many as you
        like — each one is kept, and the first opens.
      </div>
      {status ? <div className={error ? `${styles.status} ${styles.err}` : styles.status}>{status}</div> : null}
    </div>
  );
}
