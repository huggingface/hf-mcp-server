import asyncio
from fast_agent import FastAgent

# Create the application
fast = FastAgent("mcp server tests")


# Define the agent
@fast.agent(name="anon",instruction="You are a helpful AI Agent",servers=["anon_hf"])
@fast.agent(name="DVe0UTvm4",instruction="You are a helpful AI Agent",servers=["test_hf"])
@fast.agent(name="all",instruction="You are a helpful AI Agent",servers=["test_all_hf"])

async def main():
    # use the --model command line switch or agent arguments to change model
    async with fast.run() as agent:
        await agent.interactive()


        # anonymous tool calling
        await agent.anon("***CALL_TOOL hf_whoami {}")
        await agent.anon("***CALL_TOOL hub_repo_search {}")
        await agent.anon('***CALL_TOOL hub_repo_search {"repo_types": ["model"], "author": "zai-org", "limit": 3}')
        await agent.anon('***CALL_TOOL hub_repo_search {"repo_types": ["dataset"], "author": "zai-org", "limit": 3}')
        await agent.anon('***CALL_TOOL hub_repo_search {"repo_types": ["space"], "query": "evalstate", "limit": 3}')
        await agent.anon('***CALL_TOOL hf_fs {"cmd": "search", "args": ["hf://docs", "transformers"]}')

        # authenticated test account
        await agent.DVe0UTvm4('***CALL_TOOL hf_fs {"cmd": "search", "args": ["hf://docs", "transformers"]}')
        await agent.DVe0UTvm4('***CALL_TOOL hub_repo_search {"repo_types": ["model"], "query": "qwen"}')


        # authenticated, all tools (excluding duplicate space for now)
        await agent.all('***CALL_TOOL hub_repo_details {"repo_ids": ["huggingface/transformers"]}')
        await agent.all('***CALL_TOOL hub_repo_search {"repo_types": ["dataset"], "query": "qwen"}')
        await agent.all('***CALL_TOOL hf_fs {"cmd": "search", "args": ["hf://docs", "transformers"]}')
        await agent.all('***CALL_TOOL hf_fs {"cmd": "search", "args": ["hf://papers", "llama"]}')
        await agent.all('***CALL_TOOL hub_repo_search {"repo_types": ["space"], "author": "huggingface"}')

if __name__ == "__main__":
    asyncio.run(main())
