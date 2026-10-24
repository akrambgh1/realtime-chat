import { createChatServer } from "./src/chat.js";

const PORT = process.env.PORT || 3000;
const { server } = createChatServer();

server.listen(PORT, () => {
  console.log(`Chatter is running on http://localhost:${PORT}`);
});
