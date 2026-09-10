import { useEffect } from "react";
import {
  useIsRestoring,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { InfoIcon } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { resetInnertube } from "@/lib/innertube/client";
import {
  activeAccountIdQuery,
  authLoggedInQuery,
  premiumStatusQuery,
} from "@/lib/store/auth-queries";
import { usePremiumGateDialog } from "@/lib/store/premium-gate";
import { usePremiumStore } from "@/lib/store/premium";

const PREMIUM_URL = "https://music.youtube.com/music_premium";
const YTM_URL = "https://music.youtube.com";

/**
 * Shown when a signed-out / Free user tries to start playback (the
 * audio engine calls `openPremiumGate()` instead of resolving a
 * stream). Content tracks the account state reactively: a "checking"
 * placeholder while the Premium probe is still in flight, then the
 * sign-in or upgrade message. It closes itself the moment Premium is
 * confirmed (e.g. right after signing in), so a paying user who
 * clicked play during the launch-time probe never reads a false
 * upsell.
 */
export function PremiumGateDialog() {
  const open = usePremiumGateDialog((s) => s.open);
  const setOpen = usePremiumGateDialog((s) => s.setOpen);
  const status = usePremiumStore((s) => s.status);
  const premiumOk = status === "premium";

  // Same key as usePremiumStatusSync, so it's served from the query
  // cache with no extra invoke round-trip in the common case.
  const loggedIn = useQuery({ ...authLoggedInQuery, enabled: open });
  const activeId = useQuery({ ...activeAccountIdQuery, enabled: open });
  // Same key as the sync hook again, so this usually observes the check
  // it already started. After a settled failure, opening the dialog can
  // start another one, which is the right thing to do with it.
  const premium = useQuery(
    premiumStatusQuery(open && loggedIn.data === true, activeId.data),
  );
  const qc = useQueryClient();

  // Premium confirmed while the dialog is up: nothing to explain.
  useEffect(() => {
    if (open && premiumOk) setOpen(false);
  }, [open, premiumOk, setOpen]);

  const signedOut = loggedIn.data === false;
  const fetching = loggedIn.isFetching || premium.isFetching;
  // While the persisted cache restores, every query sits pending and
  // idle: no data, no fetch, no error. That is not a verdict either.
  const restoring = useIsRestoring();
  // Offline, or retrying while the window is hidden: TanStack parks the
  // fetch instead of failing it, so this is neither a check in progress
  // nor a verdict. Say so rather than suggest signing out over it.
  const waiting = !signedOut && (loggedIn.isPaused || premium.isPaused);
  // "Checking" used to mean `status === null`, which is also what a
  // finished, failed check leaves behind, so the dialog sat on that
  // label for a check that was long over (Sep 7 2026: two and a half
  // minutes on this dialog, with the log unable to say what the check
  // had answered). Ask the queries, and use the full placeholder only
  // while there is no verdict at all; with a "free" on file the upsell
  // stays up and a re-check runs behind the button instead.
  const checking =
    !signedOut && !waiting && status === null && (fetching || restoring);
  // A settled failure, whatever the store still holds. The store keeps
  // its last verdict for playback on purpose, but a "free" the latest
  // check could not confirm is not something to upsell on.
  const failed =
    !signedOut &&
    !waiting &&
    !checking &&
    !restoring &&
    (loggedIn.isError || premium.isError || status === null);
  const retry = () => {
    // Same order as the session-refreshed listener: drop the cached
    // Cookie header first or the refetch goes out with the stale one.
    resetInnertube();
    void qc.invalidateQueries({ queryKey: ["auth-logged-in"] });
    void qc.invalidateQueries({ queryKey: ["premium-status"] });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {signedOut
              ? "Sign in to play music"
              : waiting
                ? "Waiting to reach YouTube Music"
                : failed
                  ? "Couldn't confirm your subscription"
                  : "YouTube Music Premium required"}
          </DialogTitle>
          <DialogDescription>
            {checking
              ? "Checking your YouTube Music subscription…"
              : signedOut
                ? "YTubic plays music through your YouTube Music account. Sign in with an account that has an active Music Premium subscription."
                : waiting
                  ? "The check is on hold: the connection dropped, or the window was in the background. It resumes on its own as soon as it can."
                  : failed
                    ? "YouTube Music didn't confirm the signed-in session. This usually clears once the session refreshes. If it keeps happening, sign out and back in."
                    : "Your account doesn't have an active Music Premium subscription, which YouTube requires for ad-free playback."}
          </DialogDescription>
        </DialogHeader>

        {failed && (
          <div className="flex justify-end">
            <Button variant="outline" disabled={fetching} onClick={retry}>
              {fetching ? "Checking…" : "Try again"}
            </Button>
          </div>
        )}

        {!checking && !waiting && !failed && (
          <>
            <div className="flex gap-3 rounded-lg border border-border/60 bg-surface p-3">
              <InfoIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                Free YouTube Music is supported by ads. YouTube's Terms of
                Service require those ads to play, and YTubic has no way to
                show them, so YouTube limits ad-free playback to Premium
                accounts.{" "}
                <span className="font-medium text-foreground">
                  YTubic itself stays completely free and open source, and
                  always will be.
                </span>{" "}
                You can keep listening for free, with ads, at
                music.youtube.com.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => void openUrl(YTM_URL)}>
                Listen in browser
              </Button>
              {signedOut ? (
                <Button
                  onClick={() => {
                    invoke("start_login").catch((e) =>
                      toast.error(String(e)),
                    );
                  }}
                >
                  Sign in
                </Button>
              ) : (
                <Button onClick={() => void openUrl(PREMIUM_URL)}>
                  Get Music Premium
                </Button>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
