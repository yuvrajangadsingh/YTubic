export type WhatsNewChangeType = "new" | "improved" | "fixed" | "security";

export type WhatsNewChange = {
  type: WhatsNewChangeType;
  /** Short bolded lead-in, e.g. "Discord Rich Presence". */
  title: string;
  /** One or two sentences of detail rendered after the title. */
  text: string;
};

export type WhatsNewEntry = {
  /** Semver string, e.g. "0.2.0", matched against the running app version. */
  version: string;
  /** Display date, pre-formatted so there's no locale work at runtime. */
  date: string;
  /**
   * One-line summary shown as the entry's title on the timeline, both
   * collapsed and expanded. No trailing period.
   */
  summary: string;
  /**
   * Bundled hero image served from `/public`, e.g.
   * "/whats-new/0.2.0.jpg". Entries without one render no preview box
   * at all.
   */
  image?: string;
  /**
   * Which edge of the image survives the object-cover crop. Defaults
   * to center; use "top" when the subject sits at the top of the shot.
   */
  imageAlign?: "top";
  /**
   * Typed change list. The dialog groups these into "New & Improved",
   * "Fixed", and "Security" sections with counts, in that order.
   */
  changes: WhatsNewChange[];
  /**
   * Prose message rendered as a soft note panel below the changes. Use
   * for a personal note from the developer rather than a change list.
   */
  note?: string;
  /**
   * Short call-to-action rendered as a yellow alert panel at the
   * bottom. Use for a must-read instruction, e.g. signing in again
   * after an update.
   */
  alert?: string;
};

/**
 * Curated release notes for the What's New dialog, newest first. The
 * dialog renders the whole list as a timeline with the relevant entry
 * expanded. Add an entry here for every user-facing release; keep the
 * copy free of em/en dashes.
 */
export const WHATS_NEW: WhatsNewEntry[] = [
  {
    version: "0.4.7",
    date: "September 2, 2026",
    summary: "YouTube Music's own lyrics",
    changes: [
      {
        type: "new",
        title: "Lyrics straight from YouTube Music",
        text: "Synced lyrics now come from YouTube Music itself, looked up by the track rather than by matching its title, so they cannot be another song's words. LRCLIB, Musixmatch and Genius stay behind it for anything YouTube Music does not have.",
      },
      {
        type: "improved",
        title: "Better matches from the other sources",
        text: "Titles are cleaned before they are searched, so a track called Something (Official Video) is looked up as Something. Two tracks that previously found nothing now find their words.",
      },
      {
        type: "fixed",
        title: "A missed lyrics fetch no longer sticks",
        text: "If a lyrics source failed because the network hiccuped, the app remembered that as no lyrics for an hour. A failure is now just a failure and the next attempt tries again.",
      },
    ],
  },
  {
    version: "0.4.6",
    date: "September 2, 2026",
    summary: "Updates arrive on their own from here",
    changes: [
      {
        type: "fixed",
        title: "The update itself",
        text: "0.4.5 fixed which key the app trusts, but the release build was never producing the signed package an update is delivered as, so there was nothing for the app to fetch. It does now. This is the first release the app can install on its own.",
      },
    ],
  },
  {
    version: "0.4.5",
    date: "September 2, 2026",
    summary: "The app can update itself now",
    changes: [
      {
        type: "fixed",
        title: "Updates that actually arrive",
        text: "The app was checking for updates against a signing key it does not hold, left over from the project it was forked from, so no release could ever be accepted. It now trusts its own key and releases are signed by the build that publishes them. This is the last version you have to install by hand.",
      },
      {
        type: "fixed",
        title: "The wrong video for a song",
        text: "Switching a song to its video could land on a different song from the same channel when both titles ended in the same artist and remix tags. The match now compares the song part of the title, and a video that runs far longer than the track is no longer accepted.",
      },
    ],
    alert:
      "Install this one by hand, like the last. From the next release onward the app updates itself.",
  },
  {
    version: "0.4.4",
    date: "September 2, 2026",
    summary:
      "Video up to 4K, lyrics that actually arrive, and staying signed in",
    changes: [
      {
        type: "new",
        title: "Video up to 4K",
        text: "Videos start playing while they download instead of after, and the player can seek into a file that is still arriving. 1440p and 4K, which used to pull the whole file and then show nothing, play properly now.",
      },
      {
        type: "fixed",
        title: "Lyrics that arrive at all",
        text: "One of the three lyrics sources, LRCLIB, was blocked by the app's own security policy and had never worked in an installed build. It works now, so tracks that had no lyrics may have them.",
      },
      {
        type: "fixed",
        title: "Top quality audio from a normal launch",
        text: "The 271 kbps tier from 0.4.2 only worked when the app was started from a terminal. Launched from the Dock it silently fell back to 130 kbps. It is the top tier every time now.",
      },
      {
        type: "fixed",
        title: "Songs going silent when you switched desktops",
        text: "Click a track, switch desktops while it loads, and it never started. The player now notices and starts it the moment the audio is ready, wherever you are.",
      },
      {
        type: "fixed",
        title: "Staying signed in",
        text: "The session refresh used to stop counting while the Mac slept, so a closed lid could leave the account stale for hours. It now keeps proper time, saves the account safely so an interrupted write cannot read as signed out, and a network blip no longer shows a sign-in button to a signed-in user.",
      },
      {
        type: "fixed",
        title: "Library cut off at about 25",
        text: "Playlists, saved albums and followed artists past the first page were simply missing, in the Library and in the Add to playlist menu. The whole library loads now.",
      },
      {
        type: "improved",
        title: "Smaller things",
        text: "The Go to video option finds official videos with packaged titles. Opening the queue while a video plays no longer flashes it. The fullscreen player no longer leaves a gap where the window buttons would be. Cover art accents are calmer. The app keeps its own timestamped log in Library/Logs for bug reports.",
      },
    ],
    alert:
      "This version moves the app to its own identity. On first launch your data, sign-in and cache carry over automatically, and macOS may ask once about keychain access: click Always Allow.",
  },
  {
    version: "0.4.3",
    date: "August 27, 2026",
    summary: "Collapsed sidebar tells you what things are",
    changes: [
      {
        type: "fixed",
        title: "Tooltips in the collapsed sidebar",
        text: "With the sidebar collapsed, every row is a bare icon or a cover thumbnail and the name only appeared after holding still for most of a second, so running your eye down the list showed nothing. Names now appear as soon as you hover.",
      },
    ],
  },
  {
    version: "0.4.2",
    date: "August 26, 2026",
    summary: "Your Premium audio quality, finally",
    changes: [
      {
        type: "new",
        title: "Top tier audio",
        text: "Playback used to run signed out, which capped every track at 130 kbps whatever your subscription said. It now uses your account and pulls the best tier YouTube Music offers: 271 kbps Opus at 48 kHz, roughly double what you were hearing, on every track.",
      },
      {
        type: "fixed",
        title: "Premium only tracks refusing to play",
        text: "Some tracks failed with a playback error that looked like a codec problem. YouTube was refusing them because the download was anonymous. They play now.",
      },
    ],
    note: "Tracks already in your cache were downloaded at the old quality and would keep being served from disk, so the audio cache is cleared once on this update. Everything re-downloads at full quality the next time you play it.",
  },
  {
    version: "0.4.1",
    date: "August 26, 2026",
    summary: "Playback fixes, album play counts, and a calmer accent color",
    changes: [
      {
        type: "fixed",
        title: "Songs skipping one after another",
        text: "YouTube retired the download client YTubic was pinned to, so every track failed and the queue raced to the end. Playback no longer pins a client and follows yt-dlp's own rotation, which keeps up with YouTube's changes.",
      },
      {
        type: "fixed",
        title: "Music videos cut off partway",
        text: "A song and its video are different lengths, but the video was being measured against the song's runtime. That made a 6:15 video report 12:29 and get skipped at 5:32. Every length check now uses the file that is actually playing.",
      },
      {
        type: "fixed",
        title: "Video mode turning itself on",
        text: "Watching one music video used to switch video on for good, so later launches held every song behind a loading spinner while a 4K file downloaded in the background. Video now lasts for the session and every launch starts on song.",
      },
      {
        type: "new",
        title: "Go to album",
        text: "Right click any track to open its album. Works from search and home cards too, where YouTube hides the album behind the track's own menu.",
      },
      {
        type: "new",
        title: "Video stays put with the queue open",
        text: "Opening the queue used to swap the video back to album art. It now stays docked above the list.",
      },
      {
        type: "improved",
        title: "Album play counts and runtimes",
        text: "Album track lists show YouTube Music's play counts alongside each track's length, in their own columns.",
      },
      {
        type: "improved",
        title: "Accent colors that match the cover",
        text: "The player used to take its color from the most vivid thing in the artwork, even a tiny logo, so a steel grey cover came out brass. A color now has to cover enough of the art to win, and quiet covers get a tint drawn from the whole image.",
      },
      {
        type: "improved",
        title: "Faster first play",
        text: "The downloader now unpacks once instead of on every launch, which takes seconds off starting a track that is not cached yet.",
      },
      {
        type: "improved",
        title: "Undo for destructive clicks",
        text: "Clearing the queue and other one click actions can be undone, signing out asks first, and links can be copied from the track menu.",
      },
      {
        type: "fixed",
        title: "Search history on wide windows",
        text: "Recent searches sat in a narrow strip while everything above ran the full width. It now uses the space.",
      },
    ],
  },
  {
    version: "0.4.0",
    date: "July 23, 2026",
    summary: "YTubic comes to Linux and macOS",
    image: "/whats-new/0.4.0.jpg",
    imageAlign: "top",
    changes: [
      {
        type: "new",
        title: "Linux and macOS support",
        text: "YTubic now runs on Linux and macOS, in beta while the rough edges get filed down. Grab the build for your platform from the releases page.",
      },
      {
        type: "improved",
        title: "Artist pages",
        text: "Redesigned from the ground up: a Subscribe button, reworked scrolling and header behavior across the app, and full track, album, and release lists behind every More link.",
      },
      {
        type: "improved",
        title: "Resizable layout",
        text: "Drag to resize the sidebar and the player panel.",
      },
      {
        type: "fixed",
        title: "Playlist suggestions",
        text: "Suggested tracks are no longer mixed into your playlists. They live in their own Suggestions section at the end, with a Refresh button for a fresh batch.",
      },
      {
        type: "fixed",
        title: "True shuffle",
        text: "Shuffling a playlist now uses YouTube Music's server-side shuffle across every track, not just the ones that had loaded.",
      },
      {
        type: "fixed",
        title: "Remove from playlist",
        text: "Take tracks out of your own playlists straight from the track menu.",
      },
      {
        type: "fixed",
        title: "Last.fm avatar",
        text: "Your Last.fm profile picture now shows up in the Integrations tab.",
      },
      {
        type: "fixed",
        title: "Collapsed sidebar",
        text: "Fixed clicks not landing on the Library button and the Sign in button sitting off-center.",
      },
    ],
    note: "I need your help with the macOS and Linux versions. I put them together from pull requests by [ameenalasady](https://github.com/NUber-dev/YTubic/pull/1) and [yuvrajangadsingh](https://github.com/NUber-dev/YTubic/pull/33), but I have no way to run and test them myself, so they may not work at all. I've created a Discord server so we have an easier place to discuss future fixes, suggestions, and improvements: https://discord.gg/v7JGAWWWj",
  },
  {
    version: "0.3.2",
    date: "July 11, 2026",
    summary: "Last.fm connections fixed for good",
    changes: [
      {
        type: "fixed",
        title: "Last.fm connection",
        text: 'Connecting a Last.fm account failed with an "Invalid API key" error in 0.3.0 and 0.3.1 because the release pipeline corrupted the API credentials. Head to the Integrations tab and connect your account.',
      },
    ],
  },
  {
    version: "0.3.1",
    date: "July 11, 2026",
    summary: "Last.fm scrobbling switched back on",
    changes: [
      {
        type: "fixed",
        title: "Last.fm credentials",
        text: "Version 0.3.0 shipped with Last.fm scrobbling switched off because the release build was missing its API credentials. This update turns it back on.",
      },
    ],
  },
  {
    version: "0.3.0",
    date: "July 11, 2026",
    summary: "Discord Rich Presence and Last.fm scrobbling",
    image: "/whats-new/0.3.0.jpg",
    changes: [
      {
        type: "new",
        title: "Discord Rich Presence",
        text: "Show what you're listening to on your Discord profile, complete with album art and a progress bar. Turn it on in Settings under the new Integrations tab.",
      },
      {
        type: "new",
        title: "Last.fm scrobbling",
        text: "Connect your Last.fm account to scrobble every track you play. Liking a song on YTubic loves it on Last.fm, and unliking removes it.",
      },
      {
        type: "improved",
        title: "Offline scrobble queue",
        text: "Scrobbles made while offline are queued and sent automatically once you're back online.",
      },
      {
        type: "fixed",
        title: "Mini player launch",
        text: "The floating mini player no longer fails to open after the 0.2.2 update.",
      },
    ],
  },
  {
    version: "0.2.2",
    date: "July 10, 2026",
    summary: "Sidebar playlists and the session fix",
    changes: [
      {
        type: "new",
        title: "Your playlists in the sidebar",
        text: "The sidebar now lists every playlist in your library, not just the ones you pinned. Pin a playlist to keep it at the top, or hide the ones you never open.",
      },
      {
        type: "improved",
        title: "Storage settings",
        text: "The Storage tab now shows real song titles for every cached track, plus when the next auto-clean is due.",
      },
      {
        type: "fixed",
        title: "Session expiration",
        text: "Finally fixed the bug where all songs and playlists would disappear from the library after two hours and the session would show as expired.",
      },
      {
        type: "fixed",
        title: "Windows media tile",
        text: 'The Now Playing tile no longer shows "Unknown app" instead of YTubic\'s name and icon.',
      },
      {
        type: "fixed",
        title: "Playback reliability",
        text: "Fixed a bug where some songs wouldn't load, or wouldn't load on the first try.",
      },
    ],
    alert:
      "Make sure to re-log into your account after the update to refresh the session.",
  },
  {
    version: "0.2.1",
    date: "July 8, 2026",
    summary: "Session drop bug fixed",
    changes: [
      {
        type: "fixed",
        title: "Session drops",
        text: "Version 0.2.0 had a bug where your session quietly dropped after a couple of hours: your library, playlists, and Premium status would suddenly disappear until you signed in again. This update fixes the cause. Thanks to everyone who reported it.",
      },
    ],
  },
  {
    version: "0.2.0",
    date: "July 7, 2026",
    summary: "Settings dialog and account switching",
    image: "/whats-new/0.2.0.png",
    changes: [
      {
        type: "new",
        title: "Settings",
        text: "A proper Settings dialog with General, Appearance, and Storage tabs: launch at startup, playback notifications, and a cache folder you can relocate.",
      },
      {
        type: "new",
        title: "Accounts",
        text: "Switch between the YouTube channels on one Google account; your library and likes follow the channel you pick. Sign in straight from the sidebar when you're logged out.",
      },
    ],
    note: "I really didn't want to lock playback behind anything, but YouTube's Terms of Service require ads to play and YTubic has no way to show them. To keep the project alive without breaking those terms, playback and caching now need an active YouTube Music Premium subscription. Browsing and search stay open to everyone, and YTubic itself stays completely free and open source. Thanks for understanding.",
  },
  {
    version: "0.1.0",
    date: "July 5, 2026",
    summary: "The first public release of YTubic",
    image: "/whats-new/0.1.0.jpg",
    imageAlign: "top",
    changes: [
      {
        type: "new",
        title: "YTubic for desktop",
        text: "Stream your full YouTube Music library in a native desktop app: playback, search, playlists, and your likes, wrapped in a fast dark UI.",
      },
    ],
  },
];

/** The entry for a specific version, if one exists. */
export function whatsNewFor(version: string): WhatsNewEntry | undefined {
  return WHATS_NEW.find((e) => e.version === version);
}
