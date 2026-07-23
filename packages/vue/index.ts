/**
 * movi-player/vue — a thin, typed Vue 3 wrapper around the <movi-player> web
 * component. Reflects props → attributes, wires the player's events to Vue
 * emits, and exposes the underlying element via a template ref.
 * Ships as a subpath of the main package: `npm i movi-player`, no extra install.
 *
 *   import { MoviPlayer } from "movi-player/vue";
 *   <MoviPlayer src="video.mkv" controls autoplay @qoe="onQoe" />
 *
 * Note: register `movi-player` as a custom element in your Vue build so it
 * isn't treated as a component, e.g.
 *   app.config.compilerOptions.isCustomElement = (t) => t === "movi-player";
 * (or the equivalent `@vitejs/plugin-vue` option). This wrapper renders it via
 * a render function, so the flag is only needed if you also use the raw tag.
 */
import {
  defineComponent,
  h,
  ref,
  onMounted,
  onBeforeUnmount,
  watchEffect,
  type PropType,
} from "vue";
import "movi-player/element";
import type {
  MoviElement,
  MoviSourceProps,
  MoviTrackProps,
  QoEEvent,
} from "movi-player/element";

export const MoviPlayer = defineComponent({
  name: "MoviPlayer",
  inheritAttrs: false,
  props: {
    src: String,
    poster: String,
    theme: String as PropType<"dark" | "light">,
    themecolor: String,
    volume: [Number, String],
    playbackrate: [Number, String],
    controls: { type: Boolean, default: undefined },
    autoplay: { type: Boolean, default: undefined },
    loop: { type: Boolean, default: undefined },
    muted: { type: Boolean, default: undefined },
    playsinline: { type: Boolean, default: undefined },
  },
  emits: ["ready", "qoe", "timeupdate", "play", "pause", "ended", "error"],
  setup(props, { attrs, emit, expose, slots }) {
    const elRef = ref<MoviElement | null>(null);
    expose({ element: elRef });

    // Reflect props + passthrough attrs onto the element.
    watchEffect(() => {
      const el = elRef.value;
      if (!el) return;
      const all: Record<string, unknown> = { ...attrs, ...props };
      for (const [key, value] of Object.entries(all)) {
        if (value === undefined || value === null) continue;
        // Reflect only primitives — a fallthrough event listener (onFoo) or an
        // object/array would otherwise be String()'d into a bogus attribute.
        if (typeof value === "function" || typeof value === "object") continue;
        const attr = key.toLowerCase();
        if (typeof value === "boolean") {
          if (value) el.setAttribute(attr, "");
          else el.removeAttribute(attr);
        } else {
          el.setAttribute(attr, String(value));
        }
      }
    });

    const listeners: Array<[string, EventListener]> = [];
    onMounted(() => {
      const el = elRef.value;
      if (!el) return;
      const bridge = (dom: string, vue: string) => {
        const l: EventListener = (e) => emit(vue as any, (e as CustomEvent).detail);
        el.addEventListener(dom, l);
        listeners.push([dom, l]);
      };
      bridge("movi-qoe", "qoe");
      bridge("timeupdate", "timeupdate");
      bridge("play", "play");
      bridge("pause", "pause");
      bridge("ended", "ended");
      bridge("error", "error");
      emit("ready", el);
    });
    onBeforeUnmount(() => {
      const el = elRef.value;
      listeners.forEach(([n, l]) => el?.removeEventListener(n, l));
    });

    // Forward the default slot so <source>/<track> children reach the element
    // (multi-quality, external audio, subtitles) before it parses them.
    return () => h("movi-player", { ref: elRef }, slots.default?.());
  },
});

/**
 * Typed `<source>` for a `<MoviPlayer>` child list. Maps friendly props to the
 * attributes the element parses (`height` → `data-height`, `srcLang` →
 * `srclang`, `default` → `data-default`).
 *
 *   <MoviPlayer controls>
 *     <MoviSource src="4k.mp4" :height="2160" badge="HDR" default />
 *     <MoviSource src="en.m4a" kind="audio" srcLang="en" label="English" />
 *   </MoviPlayer>
 */
export const MoviSource = defineComponent({
  name: "MoviSource",
  props: {
    src: { type: String, required: true },
    type: String,
    kind: String as PropType<"audio">,
    srcLang: String,
    label: String,
    height: Number,
    fps: Number,
    badge: String,
    bandwidth: Number,
    default: { type: Boolean, default: undefined },
  },
  setup(props) {
    return () => {
      const attrs: Record<string, unknown> = { src: props.src };
      if (props.type) attrs.type = props.type;
      if (props.kind) attrs.kind = props.kind;
      if (props.srcLang) attrs.srclang = props.srcLang;
      if (props.label) attrs.label = props.label;
      if (props.height != null) attrs["data-height"] = props.height;
      if (props.fps != null) attrs["data-fps"] = props.fps;
      if (props.badge) attrs["data-badge"] = props.badge;
      if (props.bandwidth != null) attrs["data-bandwidth"] = props.bandwidth;
      if (props.default) attrs["data-default"] = "";
      return h("source", attrs);
    };
  },
});

/** Typed `<track>` (subtitles / captions) for a `<MoviPlayer>` child list. */
export const MoviTrack = defineComponent({
  name: "MoviTrack",
  props: {
    src: { type: String, required: true },
    kind: String as PropType<"subtitles" | "captions">,
    srcLang: String,
    label: String,
    format: String as PropType<"vtt" | "srt">,
    default: { type: Boolean, default: undefined },
  },
  setup(props) {
    return () => {
      const attrs: Record<string, unknown> = {
        src: props.src,
        kind: props.kind ?? "subtitles",
      };
      if (props.srcLang) attrs.srclang = props.srcLang;
      if (props.label) attrs.label = props.label;
      if (props.format) attrs["data-format"] = props.format;
      if (props.default) attrs["data-default"] = "";
      return h("track", attrs);
    };
  },
});

export type { MoviElement, QoEEvent, MoviSourceProps, MoviTrackProps };
