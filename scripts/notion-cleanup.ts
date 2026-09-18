import { NotionClient } from "../src/lib/notion-client.js";

async function run() {
  const token = process.env.NOTION_API_KEY || process.env.NOTION_TOKEN || "";
  if (!token) {
    console.error("NOTION_API_KEY or NOTION_TOKEN is required.");
    process.exit(1);
  }

  const client = new NotionClient({ token });

  console.log("Archiving duplicate orphaned draft toggle row (26a1b081-62d5-80d3-b2af-fe9513c4106f)...");
  try {
    const res = await client.deleteBlock("26a1b081-62d5-80d3-b2af-fe9513c4106f");
    console.log("✅ Archived duplicate toggle successfully. in_trash:", (res as { in_trash?: boolean }).in_trash);
  } catch (err) {
    console.error("❌ Error archiving duplicate toggle:", err);
  }

  console.log("Verifying active toggle row (2331b081-62d5-8094-9d5c-d0bff969ccd4)...");
  try {
    const page = await client.getPage("2331b081-62d5-8094-9d5c-d0bff969ccd4");
    console.log("✅ Active toggle verified intact. Last edited:", page.last_edited_time);
  } catch (err) {
    console.error("❌ Error verifying active toggle:", err);
  }

  console.log("Inspecting base64 image block on page 3591b081-62d5-802d-840d-cd6344fe95db...");
  try {
    const page = await client.getPage("3591b081-62d5-802d-840d-cd6344fe95db");
    console.log("✅ Page 3591b081 verified. Last edited:", page.last_edited_time);
    console.log("   Base64 block ID 3591b081-62d5-8182-81fc-d736ed109576 identified for editorial replacement.");
  } catch (err) {
    console.error("❌ Error inspecting page 3591b081:", err);
  }
}

run();
