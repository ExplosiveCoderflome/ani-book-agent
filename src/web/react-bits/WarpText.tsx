// Source: React Bits (David Haz), MIT + Commons Clause License Condition v1.0.
// Adapted from TextAnimations/WarpText: https://github.com/DavidHDev/react-bits
import { useEffect, useRef, type CSSProperties } from "react";
import { Mesh, Program, Renderer, Texture, Triangle } from "ogl";
import "./WarpText.css";

export type WarpTextProps = {
  text: string; color?: string; fontSize?: string; fontWeight?: number; fontFamily?: string;
  letterSpacing?: string; warpStrength?: number; warpScale?: number; speed?: number;
  pointerInfluence?: number; pointerStrength?: number; refraction?: number; className?: string; style?: CSSProperties;
};

const vertex = `#version 300 es
in vec2 position; in vec2 uv; out vec2 vUv;
void main(){vUv=uv;gl_Position=vec4(position,0.,1.);}`;
const fragment = `#version 300 es
precision highp float; uniform sampler2D uTexture; uniform vec2 uPointer; uniform float uTime,uStrength,uScale,uPointerStrength; in vec2 vUv; out vec4 color;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);} float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);return mix(mix(hash(i),hash(i+vec2(1.,0.)),f.x),mix(hash(i+vec2(0.,1.)),hash(i+vec2(1.,1.)),f.x),f.y);}
void main(){vec2 p=vUv;vec2 drift=vec2(noise(p*uScale+uTime*.08),noise(p*uScale+14.-uTime*.06))-.5;vec2 cursor=p-uPointer;float lens=smoothstep(.46,0.,length(cursor));p+=drift*uStrength*.18-cursor*lens*uPointerStrength*.13;vec2 split=(drift-cursor*lens)*uStrength*.11;vec4 base=texture(uTexture,p);color=vec4(texture(uTexture,p+split).r,base.g,texture(uTexture,p-split).b,base.a);}`;

export default function WarpText({ text, color = "#1f1915", fontSize = "clamp(3.3rem, 5.6vw, 5.4rem)", fontWeight = 650, fontFamily = "Georgia, 'Noto Serif SC', serif", letterSpacing = "-0.035em", warpStrength = .18, warpScale = 1.7, speed = .55, pointerInfluence = .85, pointerStrength = 1.25, refraction: _refraction = .012, className = "", style }: WarpTextProps) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = ref.current; if (!container) return;
    let renderer: Renderer; try { renderer = new Renderer({ webgl: 2, alpha: true, premultipliedAlpha: false, antialias: true, dpr: Math.min(devicePixelRatio, 2) }); } catch { return; }
    const gl = renderer.gl; const canvas = gl.canvas; canvas.setAttribute("aria-hidden", "true"); container.appendChild(canvas);
    const texture = new Texture(gl, { generateMipmaps: false, minFilter: gl.LINEAR, magFilter: gl.LINEAR, wrapS: gl.CLAMP_TO_EDGE, wrapT: gl.CLAMP_TO_EDGE });
    const program = new Program(gl, { vertex, fragment, transparent: true, depthTest: false, depthWrite: false, uniforms: { uTexture: { value: texture }, uPointer: { value: new Float32Array([.5, .5]) }, uTime: { value: 0 }, uStrength: { value: warpStrength }, uScale: { value: warpScale }, uPointerStrength: { value: pointerStrength * pointerInfluence } } });
    const mesh = new Mesh(gl, { geometry: new Triangle(gl), program }); let frame = 0; let pointer: [number, number] = [.5, .5], target: [number, number] = [.5, .5], visible = true; const started = performance.now();
    const rasterize = () => { const rect = container.getBoundingClientRect(); if (!rect.width || !rect.height) return; renderer.setSize(rect.width, rect.height); const source = document.createElement("canvas"); const dpr = Math.min(devicePixelRatio, 2); source.width = rect.width * dpr; source.height = rect.height * dpr; const context = source.getContext("2d"); if (!context) return; context.scale(dpr, dpr); context.fillStyle = color; context.textAlign = "center"; context.textBaseline = "middle"; context.font = `${fontWeight} ${fontSize} ${fontFamily}`; const probe = document.createElement("span"); Object.assign(probe.style, { position: "absolute", visibility: "hidden", font: context.font, letterSpacing }); probe.textContent = text; container.appendChild(probe); const computed = getComputedStyle(probe); context.font = `${computed.fontWeight} ${computed.fontSize} ${computed.fontFamily}`; const width = context.measureText(text).width; const fit = Math.min(1, rect.width * .86 / width, rect.height * .65 / parseFloat(computed.fontSize)); context.save(); context.translate(rect.width / 2, rect.height / 2); context.scale(fit, fit); context.letterSpacing = letterSpacing; context.fillText(text, 0, 0); context.restore(); probe.remove(); texture.image = source; texture.needsUpdate = true; };
    const draw = (now: number) => { pointer = [pointer[0] + (target[0] - pointer[0]) * .08, pointer[1] + (target[1] - pointer[1]) * .08]; program.uniforms.uPointer.value[0] = pointer[0]; program.uniforms.uPointer.value[1] = pointer[1]; program.uniforms.uTime.value = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : (now - started) / 1000 * speed; renderer.render({ scene: mesh }); if (visible && !document.hidden) frame = requestAnimationFrame(draw); };
    const resize = new ResizeObserver(rasterize); resize.observe(container); const intersection = new IntersectionObserver(([entry]) => { visible = entry?.isIntersecting ?? false; if (visible && !frame) frame = requestAnimationFrame(draw); }); intersection.observe(container); const move = (event: PointerEvent) => { const rect = canvas.getBoundingClientRect(); target = [(event.clientX - rect.left) / rect.width, 1 - (event.clientY - rect.top) / rect.height]; }; canvas.addEventListener("pointermove", move); rasterize(); frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); resize.disconnect(); intersection.disconnect(); canvas.removeEventListener("pointermove", move); canvas.remove(); gl.getExtension("WEBGL_lose_context")?.loseContext(); };
  }, [color, fontFamily, fontSize, fontWeight, letterSpacing, pointerInfluence, pointerStrength, speed, text, warpScale, warpStrength]);
  return <div ref={ref} className={`warp-text ${className}`.trim()} style={style} role="img" aria-label={text} />;
}
