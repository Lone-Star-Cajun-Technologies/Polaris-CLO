<script lang="ts">
  export function renderGreeting(name: string): string {
    return `Hello, ${name}`;
  }
</script>

<main>{renderGreeting("Polaris")}</main>
