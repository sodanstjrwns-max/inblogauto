export default {
  async scheduled(event, env, ctx) {
    const response = await fetch("https://inblogauto.pages.dev/api/cron/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ count: 3, manual: false, auto_publish: true })
    });
    const result = await response.json();
    console.log("Cron result:", JSON.stringify(result));
  }
}
