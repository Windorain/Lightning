declare module 'omggif' {
  interface GifOptions {
    loop?: number | null
    palette?: number[] | null
    background?: number
  }

  interface FrameOptions {
    palette?: number[] | null
    delay?: number
    disposal?: number
  }

  export class GifWriter {
    constructor(buf: Uint8Array, width: number, height: number, opts?: GifOptions)
    addFrame(x: number, y: number, w: number, h: number, indexedPixels: Uint8Array, opts?: FrameOptions): void
    end(): number
  }
}
