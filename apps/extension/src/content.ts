const marker = "nova-agent-ready";

if (!document.getElementById(marker)) {
  const element = document.createElement("div");
  element.id = marker;
  element.dataset.status = "scaffolded";
  document.body.append(element);
}
