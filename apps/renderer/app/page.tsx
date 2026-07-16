import { Suspense } from 'react';
import Layout from './components/Layout';

export default function Home() {
  return (
    <Suspense fallback={null}>
      <Layout />
    </Suspense>
  );
}
