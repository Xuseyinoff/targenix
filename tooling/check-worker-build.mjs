// Railway API orqali worker deploymentining commit hash ini tekshirish
const token = "uBskEbFn4ye2hxmpJccymeTwSIXkn5dBr7shnMqbtZE";
const deploymentId = "60d72a5c-0668-45bc-9e05-49be02d3d620";

const query = `
  query GetDeployment($id: String!) {
    deployment(id: $id) {
      id
      status
      createdAt
      meta {
        commitHash
        commitMessage
      }
    }
  }
`;

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({ query, variables: { id: deploymentId } }),
});
const data = await res.json();
const d = data?.data?.deployment;
console.log("Worker deployment:");
console.log(`  Status:  ${d?.status}`);
console.log(`  Created: ${d?.createdAt}`);
console.log(`  Commit:  ${d?.meta?.commitHash?.substring(0, 10)} — ${d?.meta?.commitMessage}`);
