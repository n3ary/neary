<!--
  Stack — flex container with axis + gap + alignment knobs. The minimal
  primitive every other layout composes from.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';
  import { cn } from './cn';

  type Direction = 'row' | 'column';
  type Spacing = 0 | 0.5 | 1 | 1.5 | 2 | 3 | 4 | 6;
  type Align = 'start' | 'center' | 'end' | 'stretch' | 'baseline';
  type Justify = 'start' | 'center' | 'end' | 'between' | 'around' | 'evenly';

  type Props = {
    direction?: Direction;
    spacing?: Spacing;
    align?: Align;
    justify?: Justify;
    wrap?: boolean;
    class?: string;
    children?: Snippet;
  };

  let {
    direction = 'column',
    spacing = 0,
    align,
    justify,
    wrap = false,
    class: className,
    children,
  }: Props = $props();

  // Tailwind `gap-*` step (0.5 -> 1, 1 -> 2, etc.) matching MUI's 8px-grid scale
  // so converted call sites read the same as their original sx={ spacing: N }.
  const GAP: Record<Spacing, string> = {
    0: 'gap-0',
    0.5: 'gap-1',
    1: 'gap-2',
    1.5: 'gap-3',
    2: 'gap-4',
    3: 'gap-6',
    4: 'gap-8',
    6: 'gap-12',
  };
</script>

<div
  class={cn(
    'flex',
    direction === 'row' ? 'flex-row' : 'flex-col',
    GAP[spacing],
    align && `items-${align}`,
    justify && `justify-${justify}`,
    wrap && 'flex-wrap',
    className,
  )}
>
  {@render children?.()}
</div>
