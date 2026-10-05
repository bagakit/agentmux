import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { MoteAvatarSeriesDefinition, MoteAvatarSeriesParameters } from '@agentmux/core/mote-avatar-series'

type GlbDefinition = Extract<MoteAvatarSeriesDefinition, { kind: 'glb' }>
type GlbParameters = Extract<MoteAvatarSeriesParameters, { kind: 'glb' }>
type MaterialSet = { original: THREE.Material; chrome: THREE.Material; toon: THREE.Material; hybrid: THREE.Material }
export type SeriesRenderFacts = {
  frames: number; meshCount: number; rendererCount: number; contextLost: boolean
  renderCalls: number; triangles: number; materialIndices: number[]; morphIds: string[]; framingNodeIndex: number | null
}
export type SeriesGlbRenderer = {
  render(parameters: GlbParameters): string
  retry(): void
  snapshot(): SeriesRenderFacts
  dispose(): void
}

function textureResources(materials: Set<THREE.Material>): Set<THREE.Texture> {
  const textures = new Set<THREE.Texture>()
  for (const material of materials) for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture) textures.add(value)
  }
  return textures
}

/** The loader's native glTF associations are the only material/mesh/node addressing source. */
export async function createSeriesGlbRenderer(canvas: HTMLCanvasElement, definition: GlbDefinition, dataBase64: string,
  onUnavailable: (message: string) => void, onRestored: () => void, signal?: AbortSignal): Promise<SeriesGlbRenderer> {
  if (signal?.aborted) throw new DOMException('The editor is closed.', 'AbortError')
  const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setSize(256, 256, false)
  renderer.setClearColor(0x000000, 0)
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.12
  const scene = new THREE.Scene()
  const rotation = new THREE.Group(), centered = new THREE.Group()
  rotation.add(centered); scene.add(rotation)
  const key = new THREE.DirectionalLight(0xffffff, 3.2); key.position.set(-3, 6, 7)
  const fill = new THREE.DirectionalLight(0xc9dcff, 0.8); fill.position.set(5, 3, 3)
  const rim = new THREE.DirectionalLight(0xffffff, 2.1); rim.position.set(2, 5, -4)
  scene.add(key, fill, rim, new THREE.HemisphereLight(0xf4f7ff, 0x556574, 1.1))
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100)
  const gradient = new THREE.DataTexture(new Uint8Array([65, 130, 190, 245]), 4, 1, THREE.RedFormat)
  gradient.minFilter = THREE.NearestFilter; gradient.magFilter = THREE.NearestFilter
  gradient.generateMipmaps = false; gradient.needsUpdate = true
  const output = document.createElement('canvas'); output.width = output.height = 256
  const outputContext = output.getContext('2d')
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>()
  const meshMaterials = new Map<THREE.Mesh, MaterialSet[]>()
  const materialCache = new Map<THREE.Material, MaterialSet>()
  const indices = new Map<THREE.Material, number>(), roles = new Map(definition.materials?.map(value => [value.index, value.role]))
  const morphBindings = new Map<string, Array<{ mesh: THREE.Mesh; index: number }>>()
  let gltf: GLTF | null = null, environment: THREE.WebGLRenderTarget | null = null
  let lost = false, disposed = false, frames = 0, meshCount = 0
  let recovery = renderer.getContext().getExtension('WEBGL_lose_context')
  function makeEnvironment() {
    environment?.dispose()
    const room = new RoomEnvironment(), generator = new THREE.PMREMGenerator(renderer)
    try { environment = generator.fromScene(room, 0.04); scene.environment = environment.texture }
    finally { room.dispose(); generator.dispose() }
  }
  function unavailable(event: Event) {
    event.preventDefault(); lost = true
    onUnavailable('The 3D preview is unavailable. Your source and draft are kept.')
  }
  function restored() {
    if (disposed) return
    lost = false
    try {
      recovery = renderer.getContext().getExtension('WEBGL_lose_context') ?? recovery
      makeEnvironment(); onRestored()
    } catch (error) { onUnavailable(error instanceof Error ? error.message : String(error)) }
  }
  canvas.addEventListener('webglcontextlost', unavailable)
  canvas.addEventListener('webglcontextrestored', restored)
  function dispose() {
    const firstDisposal = !disposed
    disposed = true
    signal?.removeEventListener('abort', dispose)
    canvas.removeEventListener('webglcontextlost', unavailable)
    canvas.removeEventListener('webglcontextrestored', restored)
    for (const texture of textureResources(materials)) {
      texture.dispose()
      const bitmap = texture.image as { close?: () => void } | null
      bitmap?.close?.()
    }
    for (const geometry of geometries) geometry.dispose()
    for (const material of materials) material.dispose()
    geometries.clear(); materials.clear()
    if (firstDisposal) { gradient.dispose(); environment?.dispose(); renderer.dispose(); renderer.forceContextLoss() }
    gltf?.scene.removeFromParent(); scene.clear()
  }
  signal?.addEventListener('abort', dispose, { once: true })
  try {
    if (!outputContext) throw new Error('The avatar image canvas is unavailable.')
    makeEnvironment()
    const bytes = Uint8Array.from(atob(dataBase64), character => character.charCodeAt(0))
    gltf = await new GLTFLoader().parseAsync(bytes.buffer, '')
    if (disposed || signal?.aborted) throw new DOMException('The editor is closed.', 'AbortError')
    centered.add(gltf.scene); gltf.scene.updateMatrixWorld(true)
    let framing: THREE.Object3D | null = definition.framing ? null : gltf.scene
    gltf.scene.traverse(object => {
      const association = gltf!.parser.associations.get(object)
      if (definition.framing && association?.nodes === definition.framing.nodeIndex) framing = object
      if (!(object instanceof THREE.Mesh)) return
      meshCount++; geometries.add(object.geometry)
      const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material]
      for (const original of sourceMaterials) {
        materials.add(original)
        const index = gltf!.parser.associations.get(original)?.materials
        if (typeof index === 'number') indices.set(original, index)
      }
      for (const declared of definition.morphs ?? []) {
        if (association?.meshes !== declared.meshIndex) continue
        if (!object.morphTargetInfluences || declared.targetIndex >= object.morphTargetInfluences.length) continue
        const bindings = morphBindings.get(declared.id) ?? []
        bindings.push({ mesh: object, index: declared.targetIndex }); morphBindings.set(declared.id, bindings)
      }
    })
    if (meshCount === 0) throw new Error('This source has no supported 3D mesh geometry.')
    for (const declared of definition.materials ?? []) {
      if (![...indices.values()].includes(declared.index)) throw new Error('A declared material is absent from this source.')
    }
    for (const declared of definition.morphs ?? []) {
      if (!morphBindings.has(declared.id)) throw new Error('A declared expression target is absent from this source.')
    }
    if (!framing) throw new Error('The declared preview frame is absent from this source.')
    const bounds = new THREE.Box3().setFromObject(framing, true)
    if (bounds.isEmpty()) throw new Error('This source has no visible model geometry.')
    const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3())
    centered.position.copy(center).multiplyScalar(-1)
    const span = Math.max(size.x, size.y) * 1.16, extent = Math.max(size.x, size.y, size.z)
    if (!Number.isFinite(span) || span <= 0) throw new Error('This model has no usable preview frame.')
    camera.left = camera.bottom = -span / 2; camera.right = camera.top = span / 2
    camera.position.set(0, 0, extent * 3); camera.far = extent * 20 + 10
    camera.lookAt(0, 0, 0); camera.updateProjectionMatrix()
    function variants(original: THREE.Material): MaterialSet {
      const cached = materialCache.get(original)
      if (cached) return cached
      const base = original as THREE.MeshStandardMaterial
      const role = roles.get(indices.get(original) ?? -1)
      const common = { color: base.color?.clone() ?? new THREE.Color(0xffffff), map: base.map ?? null,
        side: base.side, transparent: base.transparent, opacity: base.opacity, alphaTest: base.alphaTest }
      const chrome = new THREE.MeshPhysicalMaterial({ ...common, normalMap: base.normalMap ?? null,
        metalness: role === 'graphic' ? 0.12 : 1, roughness: 0.24,
        clearcoat: role === 'graphic' ? 0 : 0.18, clearcoatRoughness: 0.30, envMapIntensity: role === 'graphic' ? 0.2 : 1.15 })
      const toon = new THREE.MeshToonMaterial({ ...common, gradientMap: gradient })
      materials.add(chrome); materials.add(toon)
      const value = { original, chrome, toon, hybrid: role === 'shell' ? chrome : role === 'graphic' ? toon : original }
      materialCache.set(original, value); return value
    }
    gltf.scene.traverse(object => {
      if (object instanceof THREE.Mesh) meshMaterials.set(object,
        (Array.isArray(object.material) ? object.material : [object.material]).map(variants))
    })
    return {
      render(parameters) {
        if (disposed) throw new Error('The 3D editor is closed.')
        if (lost) throw new Error('The browser has not restored the 3D preview yet.')
        rotation.rotation.y = parameters.yaw
        for (const [mesh, sets] of meshMaterials) {
          for (const set of sets) {
            const role = roles.get(indices.get(set.original) ?? -1)
            const chrome = set.chrome as THREE.MeshPhysicalMaterial, toon = set.toon as THREE.MeshToonMaterial
            if (role === 'shell') { chrome.color.set(parameters.color); toon.color.set(parameters.color) }
            chrome.roughness = role === 'graphic' ? Math.max(0.36, parameters.roughness) : parameters.roughness
          }
          const selected = sets.map(set => set[parameters.mode])
          mesh.material = selected.length === 1 ? selected[0]! : selected
        }
        for (const [id, bindings] of morphBindings) for (const binding of bindings) {
          binding.mesh.morphTargetInfluences![binding.index] = parameters.morphs[id] ?? 0
        }
        renderer.render(scene, camera); frames++
        outputContext.clearRect(0, 0, 256, 256); outputContext.drawImage(canvas, 0, 0, 256, 256)
        return output.toDataURL('image/png')
      },
      retry() {
        if (!lost) { onRestored(); return }
        if (recovery) recovery.restoreContext()
        else onUnavailable('The browser has no local 3D recovery extension. Your draft is kept; retry later.')
      },
      snapshot() { return { frames, meshCount, rendererCount: disposed ? 0 : 1, contextLost: lost,
        renderCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
        materialIndices: [...new Set(indices.values())], morphIds: [...morphBindings.keys()], framingNodeIndex: definition.framing?.nodeIndex ?? null } },
      dispose,
    }
  } catch (error) {
    // Parser-created resources also belong to this editor if setup failed after loading.
    gltf?.scene.traverse(object => {
      if (!(object instanceof THREE.Mesh)) return
      geometries.add(object.geometry)
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material)
    })
    dispose(); throw error
  }
}
