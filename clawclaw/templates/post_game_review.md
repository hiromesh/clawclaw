# Post-Game Review & Iteration

After each game ends (whether through natural settlement or when the user explicitly says "结束游戏，让账号等待自然结束" / "We end the game, no need to operate accounts, let them wait for natural conclusion"), you MUST execute the following review and iteration process.

## Step 1: Game Summary (游戏总结)

Analyze and summarize what happened in this game:

**Summary Structure:**
1. **Game Outcome**: Win/Loss, your faction, final player count
2. **Key Events Timeline**:
   - Early game: What happened in the first few minutes?
   - Mid game: Critical meetings, kills, discoveries
   - Late game: Final confrontations, decisive moments
3. **Your Performance**:
   - What actions did you take?
   - What decisions were correct/incorrect?
   - Any missed opportunities?
4. **Other Players Analysis**:
   - Who were the Crabs/Lobsters? How did you identify them (or fail to)?
   - Any suspicious behavior patterns observed?
   - Notable speeches or voting patterns?

## Step 2: Generate 3 Improvement Proposals

Based on the game summary, propose 3 concrete improvement options. These can include (but are not limited to):

**Type A: Behavior Tree Updates**
- Modify `decideLobster()` logic for better task prioritization
- Improve `decideCrab()` target selection strategy
- Enhance `decideNeutral()` survival/win-condition tactics
- Add new conditional branches for specific scenarios encountered

**Type B: Strategy Rule Updates**
- Update Communication Guidelines based on what worked/failed
- Refine Short-Term Goal Decision Notifications for clarity
- Add new rules for specific situations encountered

**Type C: Pattern Recognition & Memory**
- Record specific player behavior patterns (if recurring players)
- Document suspicious speech patterns or tells
- Create a "distrust list" of behaviors that correlate with being Crab

**Type D: Persona & Communication**
- Adjust persona usage based on effectiveness
- Improve speech content for better persuasion/deception
- Refine when to be aggressive vs. passive in meetings

**Type E: Technical Improvements**
- Adjust polling intervals based on game pace
- Improve movement pathfinding for specific maps
- Optimize task selection algorithms

**Proposal Format:**
```
方案 [A/B/C/D/E]: [简短标题]
- 问题识别: [本局中遇到的具体问题]
- 改进内容: [具体要修改什么]
- 预期效果: [希望达到什么效果]
```

## Step 3: User Selection

Present the 3 proposals to the user and ask them to choose one:

> "本局游戏已结束。以上是游戏总结和3个改进方案，请选择其中一项（回复 1/2/3），我将根据您的选择直接更新skill文件。"

## Step 4: Execute Iteration

Once the user selects an option:

1. **Acknowledge the selection**: Confirm which option was chosen
2. **Implement the change**: Directly modify the SKILL.md file to incorporate the improvement
3. **Document the change**: Briefly explain what was updated
4. **Version bump**: If making significant changes, increment the version number in the header (e.g., 0.8.3 → 0.8.4)

**Implementation Rules:**
- Make surgical, precise edits to the relevant sections
- Maintain the existing document structure and formatting
- Ensure new content follows the established style and conventions
- If adding new rules, place them in the appropriate existing section
- If modifying behavior trees, update the relevant decision function descriptions

## Example Workflow

**User**: "结束游戏"

**You**:
```
🎮 游戏复盘

【本局总结】
- 结果: 失败 (虾阵营)
- 关键事件: 3号在电力室被发现尸体，会议中5号带节奏投错了人...
- 表现分析: 过早暴露了自己的任务路线，被蟹跟踪击杀...

【改进方案】
方案 A: 优化虾阵营移动策略
- 问题识别: 任务路线过于固定，容易被预测
- 改进内容: 在decideLobster()中增加随机路径选择，避免重复走相同路线
- 预期效果: 降低被蟹埋伏的概率

方案 B: 增加会议发言防御机制
- 问题识别: 被怀疑时缺乏有效的自我辩护
- 改进内容: 在Communication Guidelines中增加"被质疑时的标准回应模板"
- 预期效果: 提高被冤枉时的生存率

方案 C: 记录可疑行为模式
- 问题识别: 5号的发言模式明显是蟹但没能及时识别
- 改进内容: 在skill中增加"蟹阵营常见发言特征"速查表
- 预期效果: 更快识别敌对势力

请选择一项（1/2/3）:
```

**User**: "2"

**You**: [直接编辑SKILL.md，在Communication Guidelines中添加被质疑时的回应策略]

---

**CRITICAL REMINDER**: This review process is MANDATORY after every game. Do not skip it even if the game ended quickly or seemed unremarkable. Every game provides learning opportunities.
