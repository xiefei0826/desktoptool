<script setup lang="ts">
const props = withDefaults(defineProps<{ name: string; size?: number }>(), { size: 16 })

const paths: Record<string, string> = {
  plus: 'M12 5v14M5 12h14',
  search: 'M11 4a7 7 0 1 1 0 14 7 7 0 0 1 0-14zM20 20l-3.6-3.6',
  terminal: 'M4 5h16v14H4zM7.5 10l2.5 2.5-2.5 2.5M13 15h4.5',
  server: 'M4 5h16v5H4zM4 14h16v5H4zM7.5 7.5h.01M7.5 16.5h.01',
  monitor: 'M4 5h16v10H4zM9 19h6M12 15v4',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  file: 'M6 3h7l5 5v13H6zM13 3v5h5',
  chevronRight: 'M9 6l6 6-6 6',
  chevronDown: 'M6 9l6 6 6-6',
  gear: 'M12 9a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM12 2v2.2M12 19.8V22M4.9 4.9l1.6 1.6M17.5 17.5l1.6 1.6M2 12h2.2M19.8 12H22M4.9 19.1l1.6-1.6M17.5 6.5l1.6-1.6',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20.5 12a8.5 8.5 0 1 1-2.5-6M20.5 4v6h-6',
  play: 'M8 5l11 7-11 7z',
  stop: 'M7 7h10v10H7z',
  edit: 'M4 20h4l10-10-4-4L4 16zM14 6l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  key: 'M15 4a5 5 0 1 0 2.7 9.2L20 15.5V19h-3l-1.5-1.5V15H13l-1.6-1.6A5 5 0 0 0 15 4z',
  upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
  download: 'M12 4v12M7 11l5 5 5-5M4 20h16',
  link: 'M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1',
  warning: 'M12 4l9 16H3zM12 10v4M12 17h.01',
  check: 'M5 12l5 5L20 7',
  external: 'M14 5h5v5M19 5l-8 8M18 14v5H5V6h5',
  home: 'M4 11l8-7 8 7v9H4z',
  back: 'M10 6l-6 6 6 6M4 12h16',
  save: 'M5 4h11l3 3v13H5zM8 4v6h8V4M8 20v-6h8v6',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c2.5 2.4 4 5.6 4 9s-1.5 6.6-4 9c-2.5-2.4-4-5.6-4-9s1.5-6.6 4-9z',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  lock: 'M6 11h12v9H6zM9 11V8a3 3 0 0 1 6 0v3'
}
</script>

<template>
  <svg
    :width="props.size"
    :height="props.size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] ?? ''" />
  </svg>
</template>
