/**
 * movi-player/react — a thin, typed React wrapper around the <movi-player>
 * web component. Reflects props → attributes/properties, wires the player's
 * events to React callbacks, and forwards a ref to the underlying element.
 * Ships as a subpath of the main package: `npm i movi-player`, no extra install.
 *
 *   import { MoviPlayer } from "movi-player/react";
 *   <MoviPlayer src="video.mkv" controls autoplay onQoe={console.log} />
 */
import * as React from "react";
import "movi-player/element"; // registers <movi-player> (side effect)
import type {
  MoviElement,
  MoviPlayerAttributes,
  MoviSourceProps,
  MoviTrackProps,
  QoEEvent,
} from "movi-player/element";

export type { MoviElement, QoEEvent, MoviSourceProps, MoviTrackProps };

export interface MoviPlayerProps extends MoviPlayerAttributes {
  className?: string;
  style?: React.CSSProperties;
  /** `<source>` / `<track>` children for multi-quality, external audio, or subtitles. */
  children?: React.ReactNode;
  /** Fires once the element is mounted, with the element instance. */
  onReady?: (el: MoviElement) => void;
  onQoe?: (event: QoEEvent) => void;
  onTimeUpdate?: (time: number) => void;
  onPlay?: () => void;
  onPause?: () => void;
  onEnded?: () => void;
  onError?: (error: unknown) => void;
}

const EVENT_PROPS = new Set([
  "onReady",
  "onQoe",
  "onTimeUpdate",
  "onPlay",
  "onPause",
  "onEnded",
  "onError",
  "className",
  "style",
  "children",
]);

export const MoviPlayer = React.forwardRef<MoviElement, MoviPlayerProps>(
  function MoviPlayer(props, ref) {
    const elRef = React.useRef<MoviElement | null>(null);
    React.useImperativeHandle(ref, () => elRef.current as MoviElement, []);

    // Reflect declarative attributes onto the element every render. Booleans
    // become presence/absence; everything else becomes a string attribute.
    React.useEffect(() => {
      const el = elRef.current;
      if (!el) return;
      for (const [key, value] of Object.entries(props)) {
        if (EVENT_PROPS.has(key) || value === undefined || value === null) continue;
        const attr = key.toLowerCase();
        if (typeof value === "boolean") {
          if (value) el.setAttribute(attr, "");
          else el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, String(value));
        }
      }
    });

    // Bridge web-component events to React callbacks.
    React.useEffect(() => {
      const el = elRef.current;
      if (!el) return;
      const listeners: Array<[string, EventListener]> = [];
      const add = (name: string, fn?: (detail: any) => void) => {
        if (!fn) return;
        const l: EventListener = (e) => fn((e as CustomEvent).detail);
        el.addEventListener(name, l);
        listeners.push([name, l]);
      };
      add("movi-qoe", props.onQoe);
      add("timeupdate", props.onTimeUpdate);
      if (props.onPlay) add("play", () => props.onPlay!());
      if (props.onPause) add("pause", () => props.onPause!());
      if (props.onEnded) add("ended", () => props.onEnded!());
      add("error", props.onError);
      props.onReady?.(el);
      return () => listeners.forEach(([n, l]) => el.removeEventListener(n, l));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      props.onQoe,
      props.onTimeUpdate,
      props.onPlay,
      props.onPause,
      props.onEnded,
      props.onError,
      props.onReady,
    ]);

    // createElement avoids needing a JSX.IntrinsicElements augmentation for the
    // custom tag; React passes unknown props straight through as attributes.
    // Children (<source>/<track>) are rendered into the element so they're
    // present when the player's connectedCallback parses them.
    return React.createElement(
      "movi-player",
      {
        ref: elRef,
        className: props.className,
        style: props.style,
      },
      props.children,
    );
  },
);

/**
 * A typed `<source>` for a `<MoviPlayer>` child list. Maps its friendly props
 * to the exact attributes the element parses — `height` → `data-height`,
 * `srcLang` → `srclang`, `default` → `data-default`, etc. Non-standard names go
 * through as `data-*` (or plain lowercase) so React renders them verbatim
 * instead of stripping them the way it would on a raw `<source srclang>`.
 *
 *   <MoviPlayer controls>
 *     <MoviSource src="4k.mp4"    height={2160} badge="HDR" default />
 *     <MoviSource src="1080.mp4"  height={1080} />
 *     <MoviSource src="en.m4a"    kind="audio" srcLang="en" label="English" />
 *   </MoviPlayer>
 */
export function MoviSource(props: MoviSourceProps): React.ReactElement {
  const attrs: Record<string, unknown> = { src: props.src };
  if (props.type) attrs.type = props.type;
  if (props.kind) attrs.kind = props.kind;
  if (props.srcLang) attrs.srcLang = props.srcLang;
  // `label` isn't a standard <source> attribute, so React warns on it — the
  // element reads `data-label` too, which is always valid.
  if (props.label) attrs["data-label"] = props.label;
  if (props.height != null) attrs["data-height"] = props.height;
  if (props.fps != null) attrs["data-fps"] = props.fps;
  if (props.badge) attrs["data-badge"] = props.badge;
  if (props.bandwidth != null) attrs["data-bandwidth"] = props.bandwidth;
  if (props.default) attrs["data-default"] = "";
  return React.createElement("source", attrs);
}

/** A typed `<track>` (subtitles / captions) for a `<MoviPlayer>` child list. */
export function MoviTrack(props: MoviTrackProps): React.ReactElement {
  const attrs: Record<string, unknown> = {
    src: props.src,
    kind: props.kind ?? "subtitles",
  };
  if (props.srcLang) attrs.srcLang = props.srcLang;
  if (props.label) attrs.label = props.label;
  if (props.format) attrs["data-format"] = props.format;
  if (props.default) attrs["data-default"] = "";
  return React.createElement("track", attrs);
}
