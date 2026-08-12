// Source: React Bits (David Haz), MIT + Commons Clause License Condition v1.0.
// https://github.com/DavidHDev/react-bits
import { useRef, type PropsWithChildren } from "react";
import "./react-bits.css";

export default function SpotlightCard({ children, className = "", spotlightColor = "rgba(166, 103, 34, 0.22)" }: PropsWithChildren<{ className?: string; spotlightColor?: string }>) {
  const divRef = useRef<HTMLDivElement>(null);
  return <div ref={divRef} onMouseMove={(event) => { const rect = divRef.current?.getBoundingClientRect(); if (!rect || !divRef.current) return; divRef.current.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`); divRef.current.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`); divRef.current.style.setProperty("--spotlight-color", spotlightColor); }} className={`card-spotlight ${className}`}>{children}</div>;
}
