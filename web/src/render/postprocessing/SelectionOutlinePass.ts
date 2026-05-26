// web/src/render/postprocessing/SelectionOutlinePass.ts
import {
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  NoBlending,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera,
} from 'three'
import { Pass, FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js'

const OUTLINE_COLOR = new Color(0xff8800)

const sobelVertexShader = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`

const sobelFragmentShader = /* glsl */ `
  uniform sampler2D tMask;
  uniform sampler2D tScene;
  uniform vec2 uResolution;
  uniform vec3 uOutlineColor;
  uniform float uThreshold;

  varying vec2 vUv;

  void main() {
    vec4 sceneColor = texture2D(tScene, vUv);

    vec2 texel = 1.0 / uResolution;

    float tl = texture2D(tMask, vUv + vec2(-1.0, -1.0) * texel).r;
    float t  = texture2D(tMask, vUv + vec2( 0.0, -1.0) * texel).r;
    float tr = texture2D(tMask, vUv + vec2( 1.0, -1.0) * texel).r;
    float l  = texture2D(tMask, vUv + vec2(-1.0,  0.0) * texel).r;
    float r  = texture2D(tMask, vUv + vec2( 1.0,  0.0) * texel).r;
    float bl = texture2D(tMask, vUv + vec2(-1.0,  1.0) * texel).r;
    float b  = texture2D(tMask, vUv + vec2( 0.0,  1.0) * texel).r;
    float br = texture2D(tMask, vUv + vec2( 1.0,  1.0) * texel).r;

    float gx = (tr + 2.0 * r + br) - (tl + 2.0 * l + bl);
    float gy = (bl + 2.0 * b + br) - (tl + 2.0 * t + tr);
    float edge = sqrt(gx * gx + gy * gy);

    if (edge < uThreshold) {
      gl_FragColor = sceneColor;
    } else {
      gl_FragColor = vec4(uOutlineColor, 1.0);
    }
  }
`

export class SelectionOutlinePass extends Pass {
  maskScene: Scene
  maskTarget: WebGLRenderTarget
  private _fsQuad: FullScreenQuad
  private _sobelMaterial: ShaderMaterial
  private _maskMaterial: MeshBasicMaterial
  private _camera: Camera | null = null
  private _maskCount = 0

  constructor(resolution: Vector2) {
    super()

    this.maskScene = new Scene()
    this.maskTarget = new WebGLRenderTarget(resolution.x, resolution.y)
    this.maskTarget.texture.name = 'SelectionOutlinePass.mask'

    this._maskMaterial = new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide })

    this._sobelMaterial = new ShaderMaterial({
      uniforms: {
        tMask: { value: this.maskTarget.texture },
        tScene: { value: null },
        uResolution: { value: resolution.clone() },
        uOutlineColor: { value: OUTLINE_COLOR },
        uThreshold: { value: 0.3 },
      },
      vertexShader: sobelVertexShader,
      fragmentShader: sobelFragmentShader,
      transparent: true,
      blending: NoBlending,
      depthTest: false,
      depthWrite: false,
    })

    this._fsQuad = new FullScreenQuad(this._sobelMaterial)
    this.needsSwap = true
  }

  setCamera(camera: Camera): void {
    this._camera = camera
  }

  setMaskMeshes(meshes: Mesh[]): void {
    this.maskScene.clear()
    this._maskCount = meshes.length
    for (const m of meshes) {
      m.material = this._maskMaterial
      this.maskScene.add(m)
    }
  }

  setSize(width: number, height: number): void {
    this.maskTarget.setSize(width, height)
    this._sobelMaterial.uniforms.uResolution.value.set(width, height)
  }

  dispose(): void {
    this.maskTarget.dispose()
    this._sobelMaterial.dispose()
    this._maskMaterial.dispose()
    this._fsQuad.dispose()
    this.maskScene.clear()
  }

  render(
    renderer: WebGLRenderer,
    writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    if (!this._camera) return

    const prevTarget = renderer.getRenderTarget()

    // Step 1: Render mask to mask RT (or clear it if no masks)
    renderer.setRenderTarget(this.maskTarget)
    renderer.clear()
    if (this._maskCount > 0) {
      renderer.render(this.maskScene, this._camera)
    }

    // Step 2: Composite Sobel + scene into output buffer
    // When renderToScreen, write to display; otherwise write to writeBuffer
    const outTarget = this.renderToScreen ? null : writeBuffer
    renderer.setRenderTarget(outTarget)
    if (this.clear) renderer.clear()
    this._sobelMaterial.uniforms.tMask.value = this.maskTarget.texture
    this._sobelMaterial.uniforms.tScene.value = readBuffer.texture
    this._fsQuad.render(renderer)

    renderer.setRenderTarget(prevTarget)
  }
}
