// Source: React Bits (David Haz), MIT + Commons Clause License Condition v1.0.
// https://github.com/DavidHDev/react-bits
import { useCallback, useEffect, useRef, useState } from "react";
import { motion, useAnimationFrame, useMotionValue, useTransform } from "motion/react";
import "./react-bits.css";

export default function ShinyText({ text, disabled = false, speed = 2, className = "", color = "#b5b5b5", shineColor = "#ffffff", spread = 120, yoyo = false, pauseOnHover = false, direction = "left", delay = 0 }: { text: string; disabled?: boolean; speed?: number; className?: string; color?: string; shineColor?: string; spread?: number; yoyo?: boolean; pauseOnHover?: boolean; direction?: "left" | "right"; delay?: number }) {
  const [isPaused, setIsPaused] = useState(false); const progress = useMotionValue(0); const elapsedRef = useRef(0); const lastTimeRef = useRef<number | null>(null); const directionRef = useRef(direction === "left" ? 1 : -1);
  const animationDuration = speed * 1000; const delayDuration = delay * 1000;
  useAnimationFrame((time) => {
    if (disabled || isPaused) { lastTimeRef.current = null; return; }
    if (lastTimeRef.current === null) { lastTimeRef.current = time; return; }
    const deltaTime = time - lastTimeRef.current; lastTimeRef.current = time; elapsedRef.current += deltaTime;
    const cycleDuration = animationDuration + delayDuration;
    if (yoyo) { const fullCycle = cycleDuration * 2; const cycleTime = elapsedRef.current % fullCycle; if (cycleTime < animationDuration) { const p = cycleTime / animationDuration * 100; progress.set(directionRef.current === 1 ? p : 100 - p); } else if (cycleTime < cycleDuration) progress.set(directionRef.current === 1 ? 100 : 0); else if (cycleTime < cycleDuration + animationDuration) { const p = 100 - (cycleTime - cycleDuration) / animationDuration * 100; progress.set(directionRef.current === 1 ? p : 100 - p); } else progress.set(directionRef.current === 1 ? 0 : 100); }
    else { const cycleTime = elapsedRef.current % cycleDuration; progress.set(cycleTime < animationDuration ? directionRef.current === 1 ? cycleTime / animationDuration * 100 : 100 - cycleTime / animationDuration * 100 : directionRef.current === 1 ? 100 : 0); }
  });
  useEffect(() => { directionRef.current = direction === "left" ? 1 : -1; elapsedRef.current = 0; progress.set(0); }, [direction, progress]);
  const backgroundPosition = useTransform(progress, (p) => `${150 - p * 2}% center`);
  const hover = useCallback(() => { if (pauseOnHover) setIsPaused(true); }, [pauseOnHover]); const leave = useCallback(() => { if (pauseOnHover) setIsPaused(false); }, [pauseOnHover]);
  return <motion.span className={`shiny-text ${className}`} style={{ backgroundImage: `linear-gradient(${spread}deg, ${color} 0%, ${color} 35%, ${shineColor} 50%, ${color} 65%, ${color} 100%)`, backgroundSize: "200% auto", WebkitBackgroundClip: "text", backgroundClip: "text", WebkitTextFillColor: "transparent", backgroundPosition }} onMouseEnter={hover} onMouseLeave={leave}>{text}</motion.span>;
}
