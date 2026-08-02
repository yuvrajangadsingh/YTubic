import { useEffect } from "react";
import { Loader2Icon, MonitorSpeakerIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { connectedDevice, useCastStore } from "@/lib/store/cast";

function PanelHeading({ children }: { children: string }) {
  return (
    <h3 className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </h3>
  );
}

/**
 * Body of the cast popover. Scans on open and, once a session is live,
 * turns into a summary of the device with a way out — switching
 * receivers means disconnecting first, which is also how the protocol
 * works, so there's nothing to pick while connected.
 */
export function CastDevicePicker() {
  const devices = useCastStore((s) => s.devices);
  const discovering = useCastStore((s) => s.discovering);
  const deviceId = useCastStore((s) => s.deviceId);
  const state = useCastStore((s) => s.state);
  const sessionError = useCastStore((s) => s.error);
  const lastError = useCastStore((s) => s.lastError);
  const device = useCastStore(connectedDevice);
  const discover = useCastStore((s) => s.discover);
  const connect = useCastStore((s) => s.connect);
  const disconnect = useCastStore((s) => s.disconnect);

  const connected = deviceId !== null;

  // Scan when the popover opens, and again after a disconnect drops us
  // back to the list — the devices we found before the session started
  // may be gone by now.
  //
  // Not after a FAILED connect though. That also lands here with no
  // deviceId, and rescanning wipes the list the user was aiming at and
  // makes them wait out another scan before they can retry the same row.
  useEffect(() => {
    if (connected) return;
    if (useCastStore.getState().lastError) return;
    void discover();
  }, [connected, discover]);

  if (connected) {
    return (
      <div className="flex flex-col gap-2">
        <PanelHeading>Casting to</PanelHeading>
        <div className="flex items-center gap-3 rounded-lg border border-border/60 bg-surface p-3">
          {state === "connecting" ? (
            <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <MonitorSpeakerIcon className="size-4 shrink-0 text-brand" />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate text-sm font-medium leading-none">
              {device?.name ?? "Cast device"}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              {state === "connecting"
                ? "Connecting…"
                : (device?.model ?? "Connected")}
            </span>
          </div>
        </div>
        {sessionError ? (
          <p className="px-2 text-xs leading-relaxed text-destructive">
            {sessionError}
          </p>
        ) : null}
        <Button variant="outline" size="sm" onClick={() => void disconnect()}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <PanelHeading>Cast to</PanelHeading>
        {discovering && devices.length > 0 ? (
          <Loader2Icon className="mr-2 size-3.5 animate-spin text-muted-foreground" />
        ) : null}
      </div>

      {/* A connect that failed used to leave this panel looking untouched:
          the error was only rendered in the empty-list branch, so the
          picker just bounced back to the same list and the click read as
          ignored. Show it wherever it happened. */}
      {lastError && devices.length > 0 ? (
        <p className="px-2 pb-1 text-xs leading-relaxed text-destructive">
          {lastError}
        </p>
      ) : null}

      {devices.length > 0 ? (
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {devices.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => void connect(d.id)}
              className="flex items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-accent/50"
            >
              <MonitorSpeakerIcon className="size-4 shrink-0 text-muted-foreground" />
              {/* Receiver names are user-set and routinely long ("Living
                  Room Google TV"), so the label column has to be allowed
                  to shrink before it can ellipse. */}
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-sm font-medium leading-none">
                  {d.name}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {d.model}
                </span>
              </span>
            </button>
          ))}
        </div>
      ) : discovering ? (
        <div className="flex items-center gap-3 px-2 py-4">
          <Loader2Icon className="size-4 shrink-0 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            Looking for devices…
          </span>
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 px-2 py-2">
          <p className={cn("text-sm", lastError && "text-destructive")}>
            {lastError ? "Couldn't scan for devices" : "No devices found"}
          </p>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {lastError ??
              "Check that the receiver is switched on and joined to the same wifi network."}
          </p>
          <Button variant="outline" size="sm" onClick={() => void discover()}>
            Scan again
          </Button>
        </div>
      )}
    </div>
  );
}
