const token = "uBskEbFn4ye2hxmpJccymeTwSIXkn5dBr7shnMqbtZE";
const projectId = "8302bc0a-5a3b-4f93-b37e-070d0cfeaaed";

const query = `
  query GetProjectServices($projectId: String!) {
    project(id: $projectId) {
      services {
        edges {
          node {
            id
            name
          }
        }
      }
    }
  }
`;

const res = await fetch("https://backboard.railway.com/graphql/v2", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  },
  body: JSON.stringify({ query, variables: { projectId } }),
});

const data = await res.json();
console.log("Services:");
const services = data?.data?.project?.services?.edges || [];
for (const { node } of services) {
  console.log(`  id=${node.id} name="${node.name}"`);
}
