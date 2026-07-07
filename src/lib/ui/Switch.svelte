<!-- Controlled boolean toggle. bits-ui handles a11y + keyboard; styling is ours (thumb slides on data-[state=checked]). -->
<script lang="ts">
  import { Switch as Bits } from 'bits-ui';
  import { cn } from './cn';

  type Props = {
    checked: boolean;
    onchange: (checked: boolean) => void;
    disabled?: boolean;
    class?: string;
    'aria-label'?: string;
  };

  let {
    checked,
    onchange,
    disabled = false,
    class: className,
    'aria-label': ariaLabel,
  }: Props = $props();
</script>

<Bits.Root
  bind:checked={() => checked, (v) => onchange(v)}
  {disabled}
  aria-label={ariaLabel}
  class={cn(
    'relative w-10 h-6 rounded-full transition-colors',
    'bg-[color:var(--color-border)] data-[state=checked]:bg-[color:var(--color-primary)]',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-primary)]',
    'disabled:opacity-50 disabled:cursor-not-allowed',
    className,
  )}
>
  <Bits.Thumb
    class="block w-5 h-5 bg-white rounded-full shadow translate-x-0.5 transition-transform data-[state=checked]:translate-x-[18px]"
  />
</Bits.Root>
