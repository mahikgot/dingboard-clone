import Button from '../common/Button'
import { SlActionUndo } from "react-icons/sl";

interface UndoButtonProps {
    handleUndo: () => void;
}
export default function UndoButton({ handleUndo }: UndoButtonProps) {
    return (
        <div className="absolute flex bottom-1 right-1">
            <Button Icon={SlActionUndo} onClick={handleUndo}/>
        </div>
    )
}
