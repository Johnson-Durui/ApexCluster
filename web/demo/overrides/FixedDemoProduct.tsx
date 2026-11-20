// Harmless stand-in for web/src/pages/chat/FixedDemoProduct.tsx. The demo build swaps the product module for
// this one (vite.config.ts, plugin 'demo-overrides'), so the product's bundled-app preview and its strings never
// ship. It renders nothing: isFixedDemoId() is always false in the demo, so ChatPage never opens the product modal.
import type ProductFixedDemoProduct from '../../src/pages/chat/FixedDemoProduct';

type Props = Parameters<typeof ProductFixedDemoProduct>[0];

export default function FixedDemoProduct(props: Props): null {
  void props;
  return null;
}
