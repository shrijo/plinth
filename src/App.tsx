import { Canvas } from '@react-three/fiber'
import { ContactShadows, Environment, OrbitControls } from '@react-three/drei'
import { Box } from './components/Box'

export default function App() {
  return (
    <Canvas camera={{ position: [3, 2, 4], fov: 45 }} dpr={[1, 2]}>
      <color attach="background" args={['#111']} />
      <ambientLight intensity={0.3} />
      <directionalLight position={[5, 5, 5]} intensity={1} />
      <Box position={[0, 0.5, 0]} />
      <ContactShadows position={[0, 0, 0]} opacity={0.5} scale={10} blur={2} />
      <Environment preset="city" />
      <OrbitControls makeDefault />
    </Canvas>
  )
}
