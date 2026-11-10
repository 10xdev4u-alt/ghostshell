import v86WasmUrl from 'v86/build/v86.wasm?inline';

/**
 * v86's emulator WASM as an inlined data URL.
 *
 * The release is a single HTML file, so v86 cannot fetch `build/v86.wasm`
 * from next to the page (its default). Vite's `?inline` embeds the bytes in
 * the bundle as a data URL regardless of `assetsInlineLimit`, and
 * `V86VMHandle` passes the URL to v86 as `wasm_path`.
 *
 * Trade-off: v86 derives its fallback path from `wasm_path` by replacing
 * "v86.wasm" with "v86-fallback.wasm". A data URL contains neither, so the
 * fallback module (built without SIMD128/bulk-memory for older browsers) is
 * unreachable. Browsers with WebAssembly SIMD — Chrome 91+, Firefox 89+,
 * Safari 16.4+ — instantiate the primary module directly.
 */
export const V86_WASM_URL: string = v86WasmUrl;
