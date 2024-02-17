import OpenAI from "openai";
import {
  setup,
  assign,
  fromPromise,
  enqueueActions,
  fromCallback,
  log,
  raise,
} from "xstate";
import { createAgent, createOpenAIAdapter, createSchemas } from "../src";
import { loadingAnimation } from "./helpers/loader";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const adapter = createOpenAIAdapter(openai, {
  model: "gpt-3.5-turbo-1106",
});

const loader = fromCallback(({ input }: { input: string }) => {
  const anim = loadingAnimation(input);

  return () => {
    anim.stop();
  };
});

const getUserInput = fromPromise<string, { prompt: string }>(
  async ({ input }) => {
    const topic = await new Promise<string>((res) => {
      console.log(input.prompt);
      const listener = (data: Buffer) => {
        const result = data.toString().trim();
        process.stdin.off("data", listener);
        res(result);
      };
      process.stdin.on("data", listener);
    });

    return topic;
  }
);

type QuestionParams = {
  topic: string;
  difficultyLevel: number;
};

const levels = `
Novice: For beginners, covering the most basic questions that require minimal subject knowledge.
Easy: Slightly more challenging than Novice, with straightforward questions that might require some basic understanding.
Intermediate: Questions at this level require a moderate understanding of the subject and some analytical skills.
Challenging: A step up from Intermediate, these questions demand a good grasp of the subject and the ability to apply concepts.
Advanced: For users with a strong understanding of the subject, requiring in-depth knowledge and analytical skills.
Expert: Questions that challenge even those with advanced knowledge, requiring detailed understanding and critical thinking.
Master: Beyond Expert, these questions require mastery over the subject, including the nuances and less common knowledge.
Genius: Exceptionally difficult questions that test limits, including obscure knowledge and complex problem-solving skills.
Legend: The pinnacle of difficulty, designed to challenge the most knowledgeable and skilled individuals, often requiring extraordinary insight or a creative approach to solve.
`.split("\n");

const fetchQuestion = adapter.fromChat(
  ({ topic, difficultyLevel }: QuestionParams) =>
    `Ask me an objective short answer question about ${topic}. The level of difficulty is ${
      levels[difficultyLevel - 1]
    }. Just return the question`
);

const difficultyRating = (difficultyLevel: number) => {
  return levels[difficultyLevel - 1]!.replace(/:.*/, "");
};

type AnswerParams = {
  question: string;
  answer: string;
};

const checkAnswer = adapter.fromChat(
  ({ question, answer }: AnswerParams) =>
    `The question is: ${question}. Is the following the correct answer: ${answer}. Please answer Yes or No followed by a new and an explaination of why the answer is correct or incorrect`
);

const schemas = createSchemas({
  context: {
    type: "object",
    properties: {
      score: {
        type: "number",
      },
      currentTopic: {
        type: "string",
      },
      currentQuestion: {
        type: "string",
      },
      currentAnswer: {
        type: "string",
      },
      answerResponse: {
        type: "string",
      },
      difficultyLevel: {
        type: "number",
      },
      numberOfQuestions: {
        type: "number",
      },
      questionNumber: {
        type: "number",
      },
    },
  },
  events: {
    "next question": {
      type: "object",
      properties: {},
    },
    start: {
      type: "object",
      properties: {},
    },
    submit: {
      type: "object",
      properties: {},
    },
    retry: {
      type: "object",
      properties: {},
    },
    "end game": {
      type: "object",
      properties: {},
    },
  },
});

export const quizMachine = setup({
  schemas,
  types: schemas.types,
  actors: {
    fetchQuestion,
    checkAnswer,
    getUserInput,
    loader,
  },
}).createMachine({
  context: {
    score: 0,
    currentTopic: "",
    currentQuestion: "",
    difficultyLevel: 3,
    numberOfQuestions: 10,
    questionNumber: 1,
    answerResponse: "",
    currentAnswer: "",
  },
  id: "quizGame",
  initial: "Setup",
  on: {
    "end game": {
      target: "#quizGame.Game over",
    },
  },
  states: {
    Setup: {
      onDone: {
        target: "Fetching question",
      },
      initial: "Get topic",
      states: {
        "Get topic": {
          invoke: {
            src: "getUserInput",
            input: {
              prompt: "What topic would you like to be quizzed on?",
            },
            onDone: {
              actions: assign({
                currentTopic: ({ event }) => event.output,
              }),
              target: "Questions",
            },
          },
        },
        Questions: {
          invoke: {
            src: "getUserInput",
            input: {
              prompt: "How many questions would you like to be asked?",
            },
            onDone: {
              actions: assign({
                // TODO: parse for number here
                numberOfQuestions: ({ event }) => Number(event.output),
              }),
              target: "Done",
            },
          },
        },
        Done: {
          type: "final",
        },
      },
    },
    "Fetching question": {
      invoke: [
        {
          id: "fetchQuestion",
          src: "fetchQuestion",
          input: ({ context }) => ({
            topic: context.currentTopic!,
            difficultyLevel: context.difficultyLevel!,
          }),
          onDone: {
            target: "Awaiting answer",
            actions: [
              assign({
                currentQuestion: ({ event }) =>
                  event.output.choices[0]!.message.content!,
              }),
              log(({ context }) => context.currentQuestion!),
            ],
          },
          onError: {
            target: "Failure",
          },
        },
        {
          src: "loader",
          input: ({ context }) =>
            `Fetching ${difficultyRating(
              context.difficultyLevel!
            )} question...`,
        },
      ],
      description:
        "State where the game fetches a question based on the current topic and difficulty level.",
    },
    "Awaiting answer": {
      invoke: {
        src: "getUserInput",
        input: {
          prompt: "What is your answer?",
        },
        onDone: {
          actions: assign({
            currentAnswer: ({ event }) => event.output,
          }),
          target: "Checking answer",
        },
      },
      description:
        "State where the game is waiting for the user to submit an answer to the current question.",
    },
    Failure: {
      on: {
        retry: {
          target: "Fetching question",
        },
      },
      description:
        "State to handle any errors or failures in fetching or checking answers.",
    },
    "Checking answer": {
      invoke: [
        {
          // TODO: Make this a from event followed by a chat?
          id: "checkAnswer",
          src: "checkAnswer",
          input: ({ context }) => ({
            question: context.currentQuestion!,
            answer: context.currentAnswer!,
          }),
          onDone: {
            target: "Waiting for next question",
            actions: [
              assign({
                answerResponse: ({ event }) =>
                  event.output.choices[0]!.message.content!,
              }),
              log(({ context }) => context.answerResponse!),
              enqueueActions(({ context, enqueue }) => {
                if (context.answerResponse!.startsWith("Yes")) {
                  enqueue.assign({
                    score: context.score! + context.difficultyLevel! * 10,
                    difficultyLevel: Math.min(context.difficultyLevel! + 1, 10),
                  });
                } else {
                  enqueue.assign({
                    difficultyLevel: Math.max(context.difficultyLevel! - 1, 1),
                  });
                }
              }),
              log(({ context }) => `Score: ${context.score!}`),
              log(
                ({ context }) =>
                  `New difficulty level: ${difficultyRating(
                    context.difficultyLevel!
                  )}`
              ),
            ],
          },
          onError: {
            target: "Failure",
          },
        },
        {
          src: "loader",
          input: "Checking answer...",
        },
      ],
      description:
        "State where the game checks if the submitted answer is correct or wrong.",
    },
    "Waiting for next question": {
      entry: enqueueActions(({ context, enqueue }) => {
        if (context.questionNumber! >= context.numberOfQuestions!) {
          enqueue.raise({
            type: "end game",
          });
        }
      }),
      invoke: {
        src: "getUserInput",
        input: {
          prompt: "Press enter for next question",
        },
        onDone: {
          actions: raise({
            type: "next question",
          }),
        },
      },
      on: {
        "next question": {
          actions: assign({
            questionNumber: ({ context }) => context.questionNumber! + 1,
            currentQuestion: "",
            currentAnswer: "",
            answerResponse: "",
          }),
          target: "Fetching question",
        },
      },
    },
    "Game over": {
      entry: log(({ context }) => `Final score: ${context.score}`),
      type: "final",
      description:
        "Final state when all questions have been asked or the game has been explicitly ended.",
    },
  },
  exit: () => {
    process.exit();
  },
});

const agent = createAgent(quizMachine);
agent.start();
