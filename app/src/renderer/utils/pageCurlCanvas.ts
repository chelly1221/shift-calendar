import { curlPagePoint } from './pageCurlGeometry'

export const PAGE_CURL_MARGIN = 80

const vertexSource = `
attribute vec3 position;
attribute vec3 normal;
attribute vec2 uv;
uniform vec2 viewport;
uniform float perspective;
uniform lowp float shadow;
varying vec2 texCoord;
varying vec3 surfaceNormal;
varying float elevation;
void main() {
  vec3 p = position;
  elevation = p.z;
  if (shadow > 0.5) { p.xy += vec2(0.18, 0.3) * p.z; p.z = 0.0; }
  float zoom = perspective / (perspective - p.z);
  vec2 projected = (p.xy - viewport * 0.5) * zoom / viewport * 2.0;
  gl_Position = vec4(projected.x, -projected.y, -p.z / perspective, 1.0);
  texCoord = uv;
  surfaceNormal = normal;
}`
const fragmentSource = `
precision mediump float;
uniform sampler2D paper;
uniform lowp float shadow;
uniform float opacity;
varying vec2 texCoord;
varying vec3 surfaceNormal;
varying float elevation;
void main() {
  if (shadow > 0.5) {
    gl_FragColor = vec4(0.09, 0.12, 0.17, 0.17 * smoothstep(1.0, 50.0, elevation) * opacity);
    return;
  }
  vec3 ink = texture2D(paper, texCoord).rgb;
  vec3 n = normalize(surfaceNormal);
  float light = 0.78 + 0.22 * abs(dot(n, normalize(vec3(-0.35, -0.4, 0.9))));
  vec3 color = gl_FrontFacing ? ink : mix(vec3(1.0, 0.985, 0.955), ink, 0.075);
  float sheen = pow(max(0.0, dot(n, normalize(vec3(0.1, -0.3, 1.0)))), 18.0) * 0.035;
  gl_FragColor = vec4(color * light + sheen, opacity);
}`

/** Rasterize an actual calendar snapshot over a curved, double-sided paper mesh. */
export function createPageCurl(image: HTMLImageElement, width: number, height: number, previous: boolean) {
  const canvas = document.createElement('canvas')
  const sizeX = width + PAGE_CURL_MARGIN * 2, sizeY = height + PAGE_CURL_MARGIN * 2
  const ratio = Math.min(window.devicePixelRatio || 1, 1.5)
  canvas.width = Math.round(sizeX * ratio); canvas.height = Math.round(sizeY * ratio)
  canvas.style.width = `${sizeX}px`; canvas.style.height = `${sizeY}px`
  const gl = canvas.getContext('webgl', { alpha: true, antialias: true, premultipliedAlpha: false })
  if (!gl) return null
  const shaders: WebGLShader[] = [], buffers: WebGLBuffer[] = []
  const program = gl.createProgram()!, texture = gl.createTexture()!
  const dispose = () => {
    buffers.forEach((buffer) => gl.deleteBuffer(buffer))
    shaders.forEach((shader) => gl.deleteShader(shader))
    gl.deleteTexture(texture); gl.deleteProgram(program)
    gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
  try {
    for (const [type, source] of [[gl.VERTEX_SHADER, vertexSource], [gl.FRAGMENT_SHADER, fragmentSource]] as const) {
      const shader = gl.createShader(type)!
      shaders.push(shader); gl.shaderSource(shader, source); gl.compileShader(shader)
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error('Page shader unavailable')
      gl.attachShader(program, shader)
    }
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error('Page mesh unavailable')
    gl.useProgram(program)
    const columns = 96, rows = 72
    const vertices = new Float32Array((columns + 1) * (rows + 1) * 8)
    const indices = new Uint16Array(columns * rows * 6)
    let index = 0
    for (let row = 0; row < rows; row++) for (let col = 0; col < columns; col++) {
      const a = row * (columns + 1) + col, b = a + columns + 1
      indices.set([a, b, a + 1, a + 1, b, b + 1], index); index += 6
    }
    const vertexBuffer = gl.createBuffer()!, indexBuffer = gl.createBuffer()!
    buffers.push(vertexBuffer, indexBuffer)
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer); gl.bufferData(gl.ARRAY_BUFFER, vertices.byteLength, gl.DYNAMIC_DRAW)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    for (const [name, count, offset] of [['position', 3, 0], ['normal', 3, 12], ['uv', 2, 24]] as const) {
      const location = gl.getAttribLocation(program, name)
      gl.enableVertexAttribArray(location); gl.vertexAttribPointer(location, count, gl.FLOAT, false, 32, offset)
    }
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image)
    gl.uniform1i(gl.getUniformLocation(program, 'paper'), 0)
    gl.uniform2f(gl.getUniformLocation(program, 'viewport'), sizeX, sizeY)
    gl.uniform1f(gl.getUniformLocation(program, 'perspective'), Math.max(1800, width * 2))
    gl.viewport(0, 0, canvas.width, canvas.height)
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA)
    const shadow = gl.getUniformLocation(program, 'shadow'), opacity = gl.getUniformLocation(program, 'opacity')
    const render = (progress: number) => {
      let offset = 0
      for (let row = 0; row <= rows; row++) for (let col = 0; col <= columns; col++) {
        const u = col / columns, v = row / rows
        const point = curlPagePoint(u * width, v * height, width, height, progress, previous)
        vertices.set([point.x + PAGE_CURL_MARGIN, point.y + PAGE_CURL_MARGIN, point.z,
          point.nx, point.ny, point.nz, u, v], offset)
        offset += 8
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer); gl.bufferSubData(gl.ARRAY_BUFFER, 0, vertices)
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
      gl.uniform1f(opacity, Math.min(1, (1 - progress) / 0.09))
      gl.disable(gl.DEPTH_TEST); gl.uniform1f(shadow, 1)
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
      gl.enable(gl.DEPTH_TEST); gl.depthFunc(gl.LEQUAL); gl.uniform1f(shadow, 0)
      gl.drawElements(gl.TRIANGLES, indices.length, gl.UNSIGNED_SHORT, 0)
    }
    return { canvas, render, dispose }
  } catch { dispose(); return null }
}
