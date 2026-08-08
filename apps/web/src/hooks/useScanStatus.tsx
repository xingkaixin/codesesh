import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { type ScanStatusEvent, fetchScanStatus } from "../lib/api";

class ScanStatusStore {
  private status: ScanStatusEvent | null;
  private readonly listeners = new Set<() => void>();
  private loadPromise: Promise<void> | null = null;

  constructor(
    initialStatus: ScanStatusEvent | null,
    private readonly loadStatus: () => Promise<ScanStatusEvent>,
  ) {
    this.status = initialStatus;
  }

  readonly getSnapshot = (): ScanStatusEvent | null => this.status;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly publish = (next: ScanStatusEvent): void => {
    if (this.status && next.updatedAt < this.status.updatedAt) return;
    this.status = next;
    for (const listener of this.listeners) listener();
  };

  load(): void {
    if (this.status || this.loadPromise) return;
    this.loadPromise = this.loadStatus()
      .then(this.publish)
      .catch((error) => {
        console.error("Failed to load scan status:", error);
      })
      .finally(() => {
        this.loadPromise = null;
      });
  }
}

const ScanStatusContext = createContext<ScanStatusStore | null>(null);

export function ScanStatusProvider({
  children,
  initialStatus = null,
  loadStatus = fetchScanStatus,
}: {
  children?: ReactNode;
  initialStatus?: ScanStatusEvent | null;
  loadStatus?: () => Promise<ScanStatusEvent>;
}) {
  const [store] = useState(() => new ScanStatusStore(initialStatus, loadStatus));

  useEffect(() => store.load(), [store]);

  return <ScanStatusContext.Provider value={store}>{children}</ScanStatusContext.Provider>;
}

export function useScanStatus(): ScanStatusEvent | null {
  const store = useScanStatusStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

export function useScanStatusPublisher(): (status: ScanStatusEvent) => void {
  return useScanStatusStore().publish;
}

function useScanStatusStore(): ScanStatusStore {
  const store = useContext(ScanStatusContext);
  if (!store) throw new Error("ScanStatusProvider is missing");
  return store;
}
