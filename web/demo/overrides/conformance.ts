// Type-only check, never bundled (main.ts does not import it); `npm run typecheck:demo` compiles it.
// It fails the typecheck when an override stops providing an export, or a compatible signature, that the product
// module it replaces has.
import type * as ProductFixedDemo from '../../src/lib/fixed-demo';
import type * as DemoFixedDemo from './fixed-demo';
import type ProductFixedDemoProduct from '../../src/pages/chat/FixedDemoProduct';
import type DemoFixedDemoProduct from './FixedDemoProduct';

type Assert<T extends true> = T;
type Assignable<From, To> = [From] extends [To] ? true : false;

// The product's FIXED_DEMO_PROMPT has a string literal type; the demo prompt is a different literal on purpose.
type ProductApi = Omit<typeof ProductFixedDemo, 'FIXED_DEMO_PROMPT'> & { FIXED_DEMO_PROMPT: string };

export type FixedDemoConforms = Assert<Assignable<typeof DemoFixedDemo, ProductApi>>;
export type FixedDemoProductPropsConform = Assert<Assignable<Parameters<typeof ProductFixedDemoProduct>[0], Parameters<typeof DemoFixedDemoProduct>[0]>>;
