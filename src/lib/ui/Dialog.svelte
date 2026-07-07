<!-- Full-screen-capable modal. Wraps bits-ui's Dialog with the MUI-shape API call sites are familiar with (open + onclose + fullScreen). Animation + overlay + focus trap + escape handling all come from bits-ui. Composes Root + Portal + Overlay + Content from one element; consumer writes plain content inside (often with DialogTitle + DialogContent helpers). -->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Dialog as Bits } from 'bits-ui';
  import { X } from 'lucide-svelte';
  import { cn } from './cn';

  type MaxWidth = 'xs' | 'sm' | 'md' | 'lg';

  type Props = {
    open: boolean;
    onclose: () => void;
    /** When true the content covers the viewport edge-to-edge. */
    fullScreen?: boolean;
    /** Max width when not fullScreen. */
    maxWidth?: MaxWidth;
    class?: string;
    children?: Snippet;
  };

  let {
    open,
    onclose,
    fullScreen = false,
    maxWidth = 'sm',
    class: className,
    children,
  }: Props = $props();

  const MAX_W: Record<MaxWidth, string> = {
    xs: 'max-w-xs',
    sm: 'max-w-sm',
    md: 'max-w-md',
    lg: 'max-w-2xl',
  };
</script>

<Bits.Root bind:open={() => open, (v) => { if (!v) onclose(); }}>
  <Bits.Portal>
    <Bits.Overlay
      class="fixed inset-0 z-50 bg-black/50 data-[state=open]:animate-in data-[state=open]:fade-in"
    />
    <Bits.Content
      class={cn(
        'fixed z-50 bg-[color:var(--color-surface)] text-[color:var(--color-fg)] shadow-xl outline-none',
        'data-[state=open]:animate-in data-[state=open]:fade-in data-[state=open]:zoom-in-95',
        fullScreen
          ? 'inset-0 w-screen h-screen'
          : `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-2rem)] ${MAX_W[maxWidth]} rounded-lg`,
        className,
      )}
    >
      {@render children?.()}
    </Bits.Content>
  </Bits.Portal>
</Bits.Root>
