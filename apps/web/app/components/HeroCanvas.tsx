'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Icosahedron } from '@react-three/drei';
import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

function AudioMesh() {
  const meshRef = useRef<THREE.Group>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial>(null);
  const light1Ref = useRef<THREE.Light>(null);
  const light2Ref = useRef<THREE.Light>(null);
  const beatEnergyRef = useRef(0);
  const [isReduced, setIsReduced] = useState(false);

  useEffect(() => {
    const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setIsReduced(prefersReduced);
  }, []);

  useFrame(() => {
    if (isReduced || !meshRef.current) return;

    const elapsed = performance.now() * 0.001; // seconds

    // Synthetic beat pulse: ~1.8 Hz (108 BPM). Range 0-1.
    beatEnergyRef.current = Math.sin(elapsed * Math.PI * 2 * 1.8) * 0.5 + 0.5;

    // Continuous rotation, slightly faster for more energy.
    meshRef.current.rotation.x += 0.0004;
    meshRef.current.rotation.y += 0.0006;
    meshRef.current.rotation.z += 0.0003;

    // Scale: base 1 + beat-driven pulse (0 to 15%).
    const beatScale = 1 + beatEnergyRef.current * 0.15;
    meshRef.current.scale.set(beatScale, beatScale, beatScale);

    // Update material emissive intensity with beat energy (0.6 to 1.1).
    if (materialRef.current) {
      materialRef.current.emissiveIntensity = 0.6 + beatEnergyRef.current * 0.5;
    }

    // Modulate point-light intensities with beat energy for visual rhythm.
    if (light1Ref.current instanceof THREE.Light) {
      light1Ref.current.intensity = 1.2 + beatEnergyRef.current * 0.4;
    }
    if (light2Ref.current instanceof THREE.Light) {
      light2Ref.current.intensity = 0.8 + beatEnergyRef.current * 0.3;
    }
  });

  if (isReduced) {
    return null;
  }

  return (
    <group ref={meshRef}>
      <Icosahedron args={[2.4, 5]}>
        <meshStandardMaterial
          ref={materialRef}
          color="#a855f7"
          emissive="#7c3aed"
          emissiveIntensity={0.6}
          metalness={0.25}
          roughness={0.4}
          wireframe={false}
        />
      </Icosahedron>
      <Icosahedron args={[2.5, 5]}>
        <meshStandardMaterial
          color="#a855f7"
          emissive="#a855f7"
          emissiveIntensity={0.15}
          metalness={0}
          roughness={1}
          wireframe={true}
          transparent={true}
          opacity={0.35}
        />
      </Icosahedron>
      <pointLight ref={light1Ref} position={[5, 5, 5]} intensity={1.2} color="#7c3aed" />
      <pointLight ref={light2Ref} position={[-5, -5, 5]} intensity={0.8} color="#a855f7" />
    </group>
  );
}

export default function HeroCanvas() {
  const [isReduced, setIsReduced] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    setIsReduced(prefersReduced);
  }, []);

  if (!mounted || isReduced) {
    return null;
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        pointerEvents: 'none',
      }}
    >
      <Canvas
        camera={{ position: [0, 0, 5], fov: 45 }}
        dpr={[1, 2]}
        frameloop="always"
        gl={{
          antialias: true,
          alpha: true,
          preserveDrawingBuffer: false,
        }}
        style={{
          width: '100%',
          height: '100%',
        }}
      >
        <ambientLight intensity={0.6} />
        <AudioMesh />
      </Canvas>
    </div>
  );
}
