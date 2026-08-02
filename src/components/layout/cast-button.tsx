import { CastIcon } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CastDevicePicker } from "@/components/layout/cast-device-picker";
import { cn } from "@/lib/utils";
import { connectedDevice, useCastEvents, useCastStore } from "@/lib/store/cast";
import { useCastBridge } from "@/lib/cast-bridge";

/**
 * Cast entry point for the player bar. Idle it's a plain glyph; with a
 * session it goes accented and grows a label for the receiver.
 *
 * Also the mount point for the cast event bridge — it's the one piece
 * of cast UI that's always on screen, and the store re-syncs itself on
 * mount so a layout switch (which remounts the player bar) can't strand
 * the UI on stale session state.
 */
export function CastButton() {
  useCastEvents();
  useCastBridge();
  const deviceId = useCastStore((s) => s.deviceId);
  const device = useCastStore(connectedDevice);

  const connected = deviceId !== null;
  const name = device?.name ?? "Cast device";
  const label = connected ? `Casting to ${name}` : "Cast to device";

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size={connected ? "sm" : "icon"}
              aria-label={label}
              // The bottom row runs out of space around the 320px minimum
              // player width, so the labelled variant opts into shrinking
              // (buttons are shrink-0 by default) and gives up its label
              // width first. `min-w-0` on the label is what lets `truncate`
              // engage instead of the whole row overflowing.
              className={cn(connected && "min-w-0 max-w-28 shrink text-brand")}
            >
              <CastIcon />
              {connected ? (
                <span className="min-w-0 truncate">{name}</span>
              ) : null}
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="center"
        side="top"
        sideOffset={12}
        className="w-72 p-2"
      >
        <CastDevicePicker />
      </PopoverContent>
    </Popover>
  );
}
